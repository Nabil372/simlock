import type { TokenIdentity } from "../../http/token-store.js";
import { failure, frontReply } from "../shared/replies.js";
import { leaseCallFields, leaseIdOf, type RpcRead } from "../shared/rpc.js";
import { exchange, relay, releaseSimlock, type FrontContext } from "./context.js";

export async function release(
  context: FrontContext,
  identity: TokenIdentity,
  call: RpcRead & { readonly kind: "request" },
  forwarded: Request,
): Promise<Response> {
  const reply = await exchange(context, forwarded, identity);
  if (reply.response === undefined) {
    return frontReply(failure("agent-device did not answer the release"), call);
  }
  const leaseId = leaseIdOf(leaseCallFields(call.params).leaseId);
  const entry = leaseId === undefined ? undefined : context.map.get(leaseId);
  if (
    leaseId !== undefined &&
    entry?.identity.requesterId === identity.requesterId &&
    entry.endedAt === undefined &&
    reply.reading.kind === "success" &&
    (await releaseSimlock(context, entry.identity, leaseId))
  ) {
    context.map.markEnded(leaseId);
  }
  return relay(reply);
}
