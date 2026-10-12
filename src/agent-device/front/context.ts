import type { HttpDispatch } from "../../http/dispatcher-session.js";
import type { TokenIdentity } from "../../http/token-store.js";
import type { Clock, Logger } from "../../ports/index.js";
import { buildHttpSession } from "../../http/dispatcher-session.js";
import { mapError } from "../../http/errors.js";
import { readReply, type ReplyReading } from "../shared/rpc.js";
import type { FrontMap } from "./front-map.js";
import type { HostLink } from "./host-link.js";

export interface FrontContext {
  readonly link: HostLink;
  readonly map: FrontMap;
  readonly dispatch: HttpDispatch;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface Exchange {
  readonly response: Response | undefined;
  readonly text: string | undefined;
  readonly reading: ReplyReading;
}

export async function exchange(
  context: FrontContext,
  request: Request,
  identity: TokenIdentity,
): Promise<Exchange> {
  try {
    const response = await context.link.forward(request, identity);
    const text = await response.text();
    return { reading: readReply(text), response, text };
  } catch (error) {
    context.logger.warn("agent-device lease call got no usable reply", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { reading: { kind: "unusable" }, response: undefined, text: undefined };
  }
}

export function relay(reply: {
  response: Response | undefined;
  text: string | undefined;
}): Response {
  const headers = new Headers(reply.response?.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(reply.text ?? "", { headers, status: reply.response?.status ?? 502 });
}

export function leaseCall(
  origin: Request,
  method: "agent_device.lease.allocate" | "agent_device.lease.release",
  params: Record<string, unknown>,
  id: unknown,
): Request {
  const headers = new Headers(origin.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(origin.url, {
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    headers,
    method: "POST",
  });
}

export async function releaseSimlock(
  context: FrontContext,
  identity: TokenIdentity,
  leaseId: string,
): Promise<boolean> {
  try {
    await context.dispatch("lease.release", { leaseId }, buildHttpSession(identity));
    return true;
  } catch (error) {
    if (mapError(error).code === "UNKNOWN_LEASE") return true;
    context.logger.warn("agent-device front could not release a simlock lease", {
      leaseId,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
