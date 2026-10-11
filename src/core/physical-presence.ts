import type { Driver } from "./driver.js";

/**
 * The one place that reads `listPresentPhysical` and decides present or not present per ID
 * (architecture rule 10). It asks only for the IDs it is given, and an ID the driver gave no entry
 * for reads not present. It rejects when the driver does: each caller says what that means.
 */
export async function readPhysicalPresence(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const entries = await driver.listPresentPhysical(ids);
  const presence = new Map<string, boolean>(ids.map((id) => [id, false]));
  for (const entry of entries) {
    if (presence.has(entry.driverDeviceId)) presence.set(entry.driverDeviceId, entry.present);
  }
  return presence;
}
