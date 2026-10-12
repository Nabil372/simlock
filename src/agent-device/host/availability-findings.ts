import type { OptionalModuleFinding } from "../../core/index.js";
import type { AgentDeviceAvailability } from "./agent-device-supervisor.js";

export function agentDeviceFindings(
  _availability: AgentDeviceAvailability,
): readonly OptionalModuleFinding[] {
  return [];
}
