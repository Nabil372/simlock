import { describe, expect, it, vi } from "vitest";

import type { Driver, PresentPhysical } from "./driver.js";
import { readPhysicalPresence } from "./physical-presence.js";

function driverAnswering(answer: readonly PresentPhysical[]) {
  return { listPresentPhysical: vi.fn(async () => answer) } satisfies Pick<
    Driver,
    "listPresentPhysical"
  >;
}

describe("readPhysicalPresence", () => {
  it("answers each entry's present flag, and an ID with no entry not present", async () => {
    const driver = driverAnswering([
      { driverDeviceId: "A", present: true },
      { driverDeviceId: "B", present: false },
    ]);

    const presence = await readPhysicalPresence(driver, ["A", "B", "C"]);

    expect(presence.get("A")).toBe(true);
    expect(presence.get("B")).toBe(false);
    expect(presence.get("C")).toBe(false);
    expect([...presence.keys()].sort()).toEqual(["A", "B", "C"]);
  });

  it("asks the driver only for the IDs it is given", async () => {
    const driver = driverAnswering([{ driverDeviceId: "A", present: true }]);

    await readPhysicalPresence(driver, ["A", "B"]);

    expect(driver.listPresentPhysical).toHaveBeenCalledTimes(1);
    expect(driver.listPresentPhysical).toHaveBeenCalledWith(["A", "B"]);
  });

  it("rejects when the driver rejects", async () => {
    const failure = new Error("usbmuxd went away");
    const driver = { listPresentPhysical: vi.fn().mockRejectedValue(failure) };

    await expect(readPhysicalPresence(driver, ["A"])).rejects.toBe(failure);
  });
});
