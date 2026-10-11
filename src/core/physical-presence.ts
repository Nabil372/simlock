import type { Driver } from "./driver.js";

export async function readPhysicalPresence(
  _driver: Pick<Driver, "listPresentPhysical">,
  _ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  return new Map();
}
