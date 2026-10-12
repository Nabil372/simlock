import type { HttpMount } from "../../http/app.js";
import type { TokenIdentity } from "../../http/token-store.js";
import { FRONT_MOUNT, FRONT_PREFIX } from "../shared/paths.js";
import { failure, frontReply, notAvailable, refusal } from "../shared/replies.js";
import { classifyCall, readRpcBody, type RpcRead } from "../shared/rpc.js";
import { allocate } from "./allocate.js";
import type { FrontContext } from "./context.js";
import { release } from "./release.js";

type RpcRequest = RpcRead & { readonly kind: "request" };

const AGENT_TOKEN_ONLY = "refused: agent-device through simlock needs an agent token";
const CLIENT_GONE = 499;

function carry(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    body,
    headers,
    method: request.method,
    signal: request.signal,
  });
}

// why: the allocate keeps cleaning up (cancel, release) after the CLI hung up, while the handler answers at once.
function untilHangUp(signal: AbortSignal, work: Promise<Response | undefined>): Promise<Response> {
  const gone = new Promise<Response>((resolve) => {
    const answer = () => resolve(new Response(null, { status: CLIENT_GONE }));
    if (signal.aborted) answer();
    else signal.addEventListener("abort", answer, { once: true });
  });
  return Promise.race([work.then((response) => response ?? gone), gone]);
}

async function handleRpc(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
): Promise<Response> {
  const read = await readRpcBody(request);
  if (read.kind === "too-large") {
    return frontReply(refusal("refused: request body over 1 MiB"), { id: null });
  }
  if (read.kind === "malformed") {
    return frontReply(refusal("refused: send one JSON-RPC request"), { id: null });
  }
  const status = context.link.status();
  if (status.state === "unavailable") return frontReply(notAvailable(status.reason), read);
  const kind = classifyCall(read.method, read.params);
  if (kind === "wrapped-lease") {
    return frontReply(refusal("refused: send lease calls as lease RPCs"), read);
  }
  if (kind === "allocate") {
    const work = allocate(context, {
      call: read,
      identity,
      leaseMaxTtlMs: status.leaseMaxTtlMs,
      request,
    }).catch((error: unknown) => {
      context.logger.error("agent-device allocate failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return frontReply(failure("agent-device allocate failed"), read);
    });
    return untilHangUp(request.signal, work);
  }
  return kind === "release"
    ? release(context, identity, read as RpcRequest, carry(request, read.text))
    : passThrough(context, carry(request, read.text), identity, read);
}

async function passThrough(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
  rpc: { readonly id: unknown } | undefined,
): Promise<Response> {
  try {
    return await context.link.forward(request, identity);
  } catch (error) {
    return frontReply(notAvailable(error instanceof Error ? error.message : String(error)), rpc);
  }
}

export function createFront(context: FrontContext): HttpMount {
  return {
    handle: async (request, identity) => {
      const isRpc =
        request.method === "POST" && new URL(request.url).pathname === `${FRONT_PREFIX}/rpc`;
      if (identity.role !== "agent") {
        return frontReply(refusal(AGENT_TOKEN_ONLY, 403), isRpc ? { id: null } : undefined);
      }
      if (isRpc) return handleRpc(context, request, identity);
      const status = context.link.status();
      if (status.state === "unavailable") return frontReply(notAvailable(status.reason), undefined);
      return passThrough(context, request, identity, undefined);
    },
    prefix: FRONT_MOUNT,
  };
}
