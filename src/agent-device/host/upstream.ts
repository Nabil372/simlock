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

  current(): AgentDeviceUpstreamState {
    return { reason: "not implemented", state: "unavailable" };
  }

  async fetch(request: Request): Promise<Response> {
    return globalThis.fetch(request);
  }
}
