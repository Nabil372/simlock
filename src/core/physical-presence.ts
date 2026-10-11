import type { AbsentReason } from "./domain.js";
import type { Driver } from "./driver.js";

/** What one presence read says of one device: its OS version if present, why not if not. */
export type PhysicalRead =
  | { readonly present: true; readonly osVersion?: string }
  | { readonly present: false; readonly reason: AbsentReason };

/**
 * The one presence check (architecture rule 10): grant, a failed reclaim, a quarantine retry and
 * the watcher all read through it. An ID the driver gave no entry for is not present, and so is
 * an entry for an ID that was not asked about, left out.
 */
export async function readPhysicalPresenceDetail(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, PhysicalRead>> {
  const entries = await driver.listPresentPhysical(ids);
  const reads = new Map<string, PhysicalRead>(
    ids.map((id) => [id, { present: false, reason: "not-present" }]),
  );
  for (const entry of entries) {
    if (!reads.has(entry.driverDeviceId)) continue;
    reads.set(
      entry.driverDeviceId,
      entry.present
        ? {
            present: true,
            ...(entry.osVersion === undefined ? {} : { osVersion: entry.osVersion }),
          }
        : { present: false, reason: entry.reason ?? "not-present" },
    );
  }
  return reads;
}

export async function readPhysicalPresence(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const reads = await readPhysicalPresenceDetail(driver, ids);
  return new Map([...reads].map(([id, read]) => [id, read.present]));
}
