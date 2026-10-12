import type { AgentDeviceAvailability } from "./agent-device-supervisor.js";

export type AgentDeviceUpstreamState =
  | {
      readonly state: "running";
      readonly baseUrl: string;
      readonly token: string;
      readonly generation: number;
      readonly leaseMaxTtlMs: number;
    }
  | { readonly state: "unavailable"; readonly reason: string };

export interface AgentDeviceUpstream {
  current(): AgentDeviceUpstreamState;
  fetch(request: Request): Promise<Response>;
}

export class SupervisorAgentDeviceUpstream implements AgentDeviceUpstream {
  constructor(readonly supervisor: { availability(): AgentDeviceAvailability }) {}

  // fallow-ignore-next-line unused-class-member -- reached through the AgentDeviceUpstream port by the host.
  current(): AgentDeviceUpstreamState {
    return { reason: "not implemented", state: "unavailable" };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the AgentDeviceUpstream port by the host.
  async fetch(request: Request): Promise<Response> {
    return globalThis.fetch(request);
  }
}
