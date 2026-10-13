import type { HttpDispatch } from "../http/dispatcher-session.js";
import type { HttpMount } from "../http/app.js";
import type { Clock, Logger } from "../ports/index.js";
import { FrontMap } from "./front/front-map.js";
import { createFront } from "./front/front.js";
import { InProcessHostLink, type HostLink } from "./front/host-link.js";
import { AgentDeviceHost } from "./host/host.js";
import type { AgentDeviceUpstream } from "./host/upstream.js";

export { agentDeviceFindings } from "./host/availability-findings.js";
export { AgentDeviceSupervisor } from "./host/agent-device-supervisor.js";
// fallow-ignore-next-line unused-type -- the shape `AgentDeviceSupervisor.availability()` returns, which `agentDeviceFindings` reads.
export type { AgentDeviceAvailability } from "./host/agent-device-supervisor.js";
export type { AgentDeviceUpstream } from "./host/upstream.js";
export { SupervisorAgentDeviceUpstream } from "./host/upstream.js";
export { type AgentDeviceHealthProbe, NodeAgentDeviceHealthProbe } from "./host/health.js";

export interface AgentDeviceEdgeParts {
  readonly link: HostLink;
  readonly map: FrontMap;
}

export function createAgentDeviceEdgeParts(
  upstream: AgentDeviceUpstream,
  clock: Clock,
): AgentDeviceEdgeParts {
  return { link: new InProcessHostLink(new AgentDeviceHost(upstream)), map: new FrontMap(clock) };
}

// why: a stop refuses every dispatch, so waiting allocates' lease requests are cancelled through leasing directly, before the gateway stops; otherwise they stay open across a restart.
export async function cancelWaitingAllocates(
  parts: AgentDeviceEdgeParts,
  cancel: (requesterId: string) => Promise<unknown>,
): Promise<void> {
  await Promise.allSettled(parts.map.waitingIds().map((id) => cancel(id)));
}

export function createAgentDeviceFront(
  parts: AgentDeviceEdgeParts,
  deps: { readonly dispatch: HttpDispatch; readonly clock: Clock; readonly logger: Logger },
): HttpMount {
  return createFront({ ...deps, link: parts.link, map: parts.map });
}
