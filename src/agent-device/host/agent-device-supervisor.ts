import type {
  Clock,
  Filesystem,
  Logger,
  ProcessRunner,
  ProcessSupervisor,
  TcpProbe,
} from "../../ports/index.js";
import type { AgentDeviceHealthProbe } from "./health.js";

export type AgentDevicePlatform = "ios" | "android";

export type AgentDeviceAvailability =
  | { readonly state: "off" }
  | { readonly state: "starting" }
  | {
      readonly state: "running";
      readonly version: string;
      readonly baseUrl: string;
      readonly token: string;
      readonly generation: number;
      readonly leaseMaxTtlMs: number;
      readonly platforms: readonly AgentDevicePlatform[];
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "not-found"
        | "not-agent-device"
        | "wrong-version"
        | "state-dir"
        | "start-failed";
      readonly message: string;
      readonly remedy: string;
    };

export interface AgentDeviceSupervisorOptions {
  readonly baseEnvironment: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly config: { readonly enabled: boolean; readonly command: string };
  readonly driverEnvironment: Readonly<Record<string, string>>;
  readonly filesystem: Filesystem;
  readonly healthProbe: AgentDeviceHealthProbe;
  readonly home: string;
  readonly leaseMaxTtlMs: number;
  readonly logger: Logger;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly platforms: readonly AgentDevicePlatform[];
  readonly processRunner: ProcessRunner;
  readonly processSupervisor: ProcessSupervisor;
  readonly tcpProbe: TcpProbe;
}

export class AgentDeviceSupervisor {
  #availability: AgentDeviceAvailability;

  constructor(options: AgentDeviceSupervisorOptions) {
    this.#availability = options.config.enabled ? { state: "starting" } : { state: "off" };
  }

  availability(): AgentDeviceAvailability {
    return this.#availability;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.#availability = { state: "off" };
  }
}
