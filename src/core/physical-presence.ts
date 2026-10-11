import type { AbsentReason } from "./domain.js";
import type { Driver, PresentPhysical } from "./driver.js";

export type PhysicalRead =
  | { readonly present: true; readonly osVersion?: string }
  | { readonly present: false; readonly reason: AbsentReason };

function reads(
  ids: readonly string[],
  entries: readonly PresentPhysical[],
): ReadonlyMap<string, PhysicalRead> {
  const answer = new Map<string, PhysicalRead>(
    ids.map((id) => [id, { present: false, reason: "not-present" }]),
  );
  for (const entry of entries) {
    if (!answer.has(entry.driverDeviceId)) continue;
    answer.set(
      entry.driverDeviceId,
      entry.present
        ? {
            present: true,
            ...(entry.osVersion === undefined ? {} : { osVersion: entry.osVersion }),
          }
        : { present: false, reason: entry.reason ?? "not-present" },
    );
  }
  return answer;
}

export async function readPhysicalPresenceDetail(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, PhysicalRead>> {
  return reads(ids, await driver.listPresentPhysical(ids));
}

export async function readPhysicalPresence(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const answer = reads(ids, await driver.listPresentPhysical(ids));
  return new Map([...answer].map(([id, read]) => [id, read.present]));
}
