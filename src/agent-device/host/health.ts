export interface AgentDeviceHealthProbe {
  read(baseUrl: string): Promise<unknown>;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export class NodeAgentDeviceHealthProbe implements AgentDeviceHealthProbe {
  constructor(readonly timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS) {}

  async read(_baseUrl: string): Promise<unknown> {
    return undefined;
  }
}
