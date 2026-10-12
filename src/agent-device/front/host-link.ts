import type { TokenIdentity } from "../../http/token-store.js";
import type { AgentDeviceHost } from "../host/host.js";

export interface HostLink {
  status():
    | { readonly state: "running"; readonly leaseMaxTtlMs: number }
    | { readonly state: "unavailable"; readonly reason: string };
  forward(request: Request, identity: TokenIdentity): Promise<Response>;
}

export class InProcessHostLink implements HostLink {
  constructor(private readonly host: AgentDeviceHost) {}

  // fallow-ignore-next-line unused-class-member -- reached through the HostLink port by the front.
  status(): ReturnType<HostLink["status"]> {
    return this.host.status();
  }

  // fallow-ignore-next-line unused-class-member -- reached through the HostLink port by the front.
  forward(request: Request, identity: TokenIdentity): Promise<Response> {
    return this.host.forward(request, identity);
  }
}
