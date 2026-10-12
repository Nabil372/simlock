import type { OptionalModuleFinding } from "../../core/index.js";
import type { AgentDeviceAvailability } from "./agent-device-supervisor.js";

export function agentDeviceFindings(
  availability: AgentDeviceAvailability,
): readonly OptionalModuleFinding[] {
  if (availability.state !== "unavailable") return [];
  return [
    {
      kind: "agent-device-unavailable",
      message: availability.message,
      remedy: availability.remedy,
    },
  ];
}
