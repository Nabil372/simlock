import type { Driver } from "./driver.js";

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
