import type { TokenIdentity } from "../../http/token-store.js";
import type { AgentDeviceUpstream } from "./upstream.js";

export class AgentDeviceHost {
  constructor(readonly upstream: AgentDeviceUpstream) {}

  tag(_request: Request, _identity: TokenIdentity): void {}

  authenticate(_request: Request): { readonly tenantId: string } | null {
    return null;
  }
}
