import { describe, expect, it, vi } from "vitest";

import { EventBus, type EventEnvelope } from "../bus/index.js";
import {
  FakeClock,
  JsonLinesLogger,
  type Logger,
  MemoryFilesystem,
  MemoryLogSink,
} from "../ports/index.js";
import { DeviceOperationClaims } from "./device-operation-claims.js";
import { DriverCatalog } from "./driver-catalog.js";
import type { VirtualDevice, VirtualSpec } from "./domain.js";
import { FakeDriver } from "./fake-driver.js";
import {
  QuarantineCoordinator,
  type QuarantineRegistry,
  type QuarantineRetryConfig,
} from "./quarantine-coordinator.js";
import { Registry } from "./registry.js";
import { SerializedDecision } from "./serialized-decision.js";

const spec: VirtualSpec = {
  physical: false,
  model: "iPhone 16",
  osVersion: "26.5",
  platform: "ios",
};

const retryConfig: QuarantineRetryConfig = {
  maxRetries: 2,
  retryBackoffMs: 1_000,
  retryBackoffMultiplier: 2,
  maxRetryBackoffMs: 5_000,
};

/** In-memory stand-in mirroring the four Registry methods QuarantineCoordinator calls. */
class FakeRegistry implements QuarantineRegistry {
  #devices: VirtualDevice[];
  /** The initiator of every `deleteQuarantined` commit, in order. */
  readonly deletions: string[] = [];

  constructor(devices: readonly VirtualDevice[]) {
    this.#devices = [...devices];
  }

  get snapshot(): { readonly virtualDevices: readonly VirtualDevice[] } {
    return { virtualDevices: this.#devices.map((device) => ({ ...device })) };
  }

  async enterQuarantine(deviceId: string, nextRetryAt: number): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: 0,
      quarantineNextRetryAt: nextRetryAt,
      state: "quarantined",
    }));
  }

  async recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => ({
      ...device,
      quarantineAttempts: attempts,
      quarantineNextRetryAt: nextRetryAt,
    }));
  }

  async strandQuarantine(deviceId: string, attempts: number): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => {
      const { quarantineNextRetryAt: _quarantineNextRetryAt, ...rest } = device;
      return { ...rest, quarantineAttempts: attempts };
    });
  }

  async recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<VirtualDevice> {
    return this.#update(deviceId, (device) => {
      const {
        quarantineAttempts: _quarantineAttempts,
        quarantineNextRetryAt: _quarantineNextRetryAt,
        quarantinedAt: _quarantinedAt,
        ...rest
      } = device;
      return { ...rest, state: to };
    });
  }

  async deleteQuarantined(deviceId: string, initiator: string): Promise<VirtualDevice> {
    this.deletions.push(initiator);
    return this.#update(deviceId, (device) => {
      const {
        quarantineAttempts: _quarantineAttempts,
        quarantineNextRetryAt: _quarantineNextRetryAt,
        quarantinedAt: _quarantinedAt,
        ...rest
      } = device;
      return { ...rest, state: "deleted" };
    });
  }

  /** Test-only escape hatch to simulate a device leaving quarantine out of band. */
  forceState(deviceId: string, state: VirtualDevice["state"]): void {
    this.#update(deviceId, (device) => ({ ...device, state }));
  }

  #update(deviceId: string, apply: (device: VirtualDevice) => VirtualDevice): VirtualDevice {
    const index = this.#devices.findIndex((device) => device.id === deviceId);
    const current = this.#devices[index];
    if (index === -1 || current === undefined) throw new Error(`missing device: ${deviceId}`);
    const updated = apply(current);
    this.#devices[index] = updated;
    return { ...updated };
  }
}

function device(id: string, driverDeviceId: string): VirtualDevice {
  return {
    physical: false,
    createdAt: 1,
    driverData: {},
    driverDeviceId,
    id,
    mode: "full",
    spec,
    state: "quarantined",
  };
}

async function createHarness(
  options: {
    readonly clock?: FakeClock;
    readonly config?: QuarantineRetryConfig;
    readonly driver?: FakeDriver;
    readonly logger?: Logger;
    readonly target?: Pick<VirtualDevice, "lastLeaseEndedAt" | "leaseIdentity">;
  } = {},
) {
  const clock = options.clock ?? new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = options.driver ?? new FakeDriver({ clock, platform: "ios" });
  const driverDevice = await driver.provision(spec);
  const target = { ...device("dev_1", driverDevice.deviceId), ...options.target };
  const registry = new FakeRegistry([target]);
  const notifyAvailability = vi.fn();
  const claims = new DeviceOperationClaims();
  const coordinator = new QuarantineCoordinator({
    claims,
    clock,
    config: options.config ?? retryConfig,
    decisions: new SerializedDecision(),
    drivers: new DriverCatalog([driver]),
    eventBus: bus,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    notifyAvailability,
    registry,
  });
  return { bus, claims, clock, coordinator, driver, notifyAvailability, registry, target };
}

function eventsOf(bus: EventBus): readonly EventEnvelope[] {
  return bus.replay();
}

describe("QuarantineCoordinator", () => {
  it("commits quarantine entry, emits purge-failed and quarantined, and does not wake availability", async () => {
    const harness = await createHarness();
    // enter() starts from "reclaiming" in the real flow; the fake registry only
    // needs a device row to update, so the pre-quarantine state is irrelevant here.

    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 40,
      error: "Error: purge exploded",
      leaseId: "lease-1",
    });

    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 2_000,
      state: "quarantined",
    });
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
    ]);
    expect(eventsOf(harness.bus)[1]).toMatchObject({
      payload: { deviceId: harness.target.id, maxRetries: 2, nextRetryAt: 2_000 },
    });
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("hands the driver's retried reclaim a device marked virtual", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({ clock, driver });

    await harness.coordinator.enterFromStalledTransition(harness.target.id);
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    const reclaims = driver.calls.filter((call) => call.operation === "reclaim");
    expect(reclaims.map((call) => call.arguments[0])).toEqual([
      expect.objectContaining({ physical: false }),
    ]);
  });

  it("commits stalled-transition quarantine entry, emits only quarantined, and does not wake availability", async () => {
    const harness = await createHarness();

    await harness.coordinator.enterFromStalledTransition(harness.target.id);

    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      quarantineNextRetryAt: 2_000,
      state: "quarantined",
    });
    // Unlike enter(), there was no purge -- no device.purge-failed fires.
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual(["device.quarantined"]);
    expect(eventsOf(harness.bus)[0]).toMatchObject({
      payload: { deviceId: harness.target.id, maxRetries: 2, nextRetryAt: 2_000 },
    });
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("retries and gives up on a stalled-transition entry exactly like a purge-failure one", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({ clock, driver });

    await harness.coordinator.enterFromStalledTransition(harness.target.id);
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.quarantined",
      "device.quarantine-recovered",
    ]);
    expect(harness.notifyAvailability).toHaveBeenCalledTimes(1);
  });

  it("recovers on a successful retry, rejoins the pool, and wakes availability", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({ clock, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(harness.registry.snapshot.virtualDevices[0]?.quarantineAttempts).toBeUndefined();
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
      "device.quarantine-recovered",
    ]);
    expect(eventsOf(harness.bus)[2]).toMatchObject({
      payload: { attempts: 1, deviceId: harness.target.id },
    });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("grows the backoff after each failed retry, capped at maxRetryBackoffMs, then gives up and destroys", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    // Calls: 1 = the initial purge (handled by the caller, not exercised here),
    // so reclaim() calls from the coordinator start at call #1 for this fresh device.
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    const harness = await createHarness({ clock, config: retryConfig, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    // First retry (attempt 1) fails; backoff grows to retryBackoffMs * multiplier^1 = 2_000.
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 1,
      quarantineNextRetryAt: 4_000,
      state: "quarantined",
    });

    // Second retry (attempt 2) fails and hits maxRetries: give up and destroy.
    harness.clock.advance(2_000);
    await flush();

    expect(harness.driver.calls.map((call) => call.operation)).toContain("destroy");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
    expect(harness.registry.deletions).toEqual(["quarantine-coordinator"]);
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
      "device.quarantine-abandoned",
    ]);
    expect(eventsOf(harness.bus)[2]).toMatchObject({
      payload: { attempts: 2, deviceId: harness.target.id },
    });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("strands a device whose give-up destroy also fails, rather than losing it silently", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    driver.failOn("destroy", 1, new Error("destroy blew up"));
    const harness = await createHarness({ clock, config: retryConfig, driver });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    // Still quarantined: not grantable, still counted against capacity, and no further retry --
    // a terminal state an operator has to clear, which is exactly why it is worth a fact.
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 2,
      state: "quarantined",
    });
    // Nothing is armed any more, so the record must not advertise a retry deadline.
    expect(harness.registry.snapshot.virtualDevices[0]?.quarantineNextRetryAt).toBeUndefined();
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
      "device.quarantine-stranded",
    ]);
    expect(eventsOf(harness.bus)[2]).toMatchObject({
      payload: { attempts: 2, deviceId: harness.target.id, error: "Error: destroy blew up" },
    });
    expect(harness.notifyAvailability).not.toHaveBeenCalled();
  });

  it("retries a spent fresh device's delete rather than an erase, and a successful retry reaches deleted, never ready", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const harness = await createHarness({
      clock,
      driver,
      target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" },
    });
    await harness.coordinator.enter({
      attemptedStrategy: "delete",
      deviceId: harness.target.id,
      duration: 0,
      error: "Error: delete exploded",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    const operations = harness.driver.calls.map((call) => call.operation);
    expect(operations).toContain("destroy");
    expect(operations).not.toContain("reclaim");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("deleted");
    expect(harness.registry.deletions).toEqual(["lease-end"]);
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual([
      "device.purge-failed",
      "device.quarantined",
    ]);
    expect(eventsOf(harness.bus)[0]).toMatchObject({ payload: { attemptedStrategy: "delete" } });
    expect(harness.notifyAvailability).toHaveBeenCalledOnce();
  });

  it("keeps a spent fresh device quarantined and re-arms when its retried delete fails", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    driver.failOn("destroy", 1, new Error("still stuck"));
    const harness = await createHarness({
      clock,
      driver,
      target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" },
    });
    await harness.coordinator.enter({
      attemptedStrategy: "delete",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 1,
      state: "quarantined",
    });
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("reclaim");
  });

  it("A failed quarantine reclaim retry logs the error and the attempt number.", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("erase still stuck"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      clock,
      driver,
      logger: new JsonLinesLogger({ clock, sink }),
    });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        module: "daemon.quarantine-coordinator",
        fields: {
          attempts: 1,
          deviceId: harness.target.id,
          error: "Error: erase still stuck",
          step: "reclaim",
        },
      }),
    ]);
  });

  it("a quarantine retry that itself throws logs at error with the device id", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("erase still stuck"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      clock,
      driver,
      logger: new JsonLinesLogger({ clock, sink }),
    });
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });
    vi.spyOn(harness.registry, "recordQuarantineRetryFailure").mockRejectedValue(
      new Error("state.json unwritable"),
    );

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(sink.records.filter((record) => record.level === "error")).toEqual([
      expect.objectContaining({
        module: "daemon.quarantine-coordinator",
        fields: {
          deviceId: harness.target.id,
          error: "Error: state.json unwritable",
          step: "retry",
        },
      }),
    ]);
  });

  it("A failed quarantine delete retry logs the error and the attempt number.", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("destroy", 1, new Error("delete still stuck"));
    const sink = new MemoryLogSink();
    const harness = await createHarness({
      clock,
      driver,
      logger: new JsonLinesLogger({ clock, sink }),
      target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" },
    });
    await harness.coordinator.enter({
      attemptedStrategy: "delete",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(sink.records).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          attempts: 1,
          deviceId: harness.target.id,
          error: "Error: delete still stuck",
          step: "delete",
        },
      }),
    ]);
  });

  it("never touches a device that left quarantine before its retry timer fires", async () => {
    const harness = await createHarness();
    await harness.coordinator.enter({
      attemptedStrategy: "wipe",
      deviceId: harness.target.id,
      duration: 0,
      error: "boom",
      leaseId: "lease-1",
    });

    // Simulate the device having been leased/recovered out of band by the time the
    // timer fires -- this is exactly the guard that keeps a leased device untouched.
    harness.registry.forceState(harness.target.id, "leased");
    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("reclaim");
    expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe("leased");
  });

  it("restores retry timers for devices still quarantined at startup", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const driverDevice = await driver.provision(spec);
    const registry = new FakeRegistry([
      {
        ...device("dev_restored", driverDevice.deviceId),
        quarantineAttempts: 1,
        quarantineNextRetryAt: 3_000,
      },
    ]);
    const notifyAvailability = vi.fn();
    const bus = new EventBus(clock);
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: bus,
      notifyAvailability,
      registry,
    });

    coordinator.restore();
    clock.advance(2_000); // now = 3_000, exactly the persisted deadline
    await flush();

    expect(registry.snapshot.virtualDevices[0]?.state).toBe("ready");
    expect(notifyAvailability).toHaveBeenCalledOnce();
  });

  it("arms no retry for a quarantined device the include filter leaves out, even one already due", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const driverDevice = await driver.provision(spec);
    const registry = new FakeRegistry([
      {
        ...device("dev_left_out", driverDevice.deviceId),
        quarantineAttempts: 1,
        quarantineNextRetryAt: 500,
      },
    ]);
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: new EventBus(clock),
      notifyAvailability: vi.fn(),
      registry,
    });

    coordinator.restore(() => false);
    clock.advance(10_000);
    await flush();

    expect(driver.calls.map((call) => call.operation)).not.toContain("reclaim");
    expect(registry.snapshot.virtualDevices[0]?.state).toBe("quarantined");
  });

  it("arms no retry timer for a device that is not quarantined", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const driverDevice = await driver.provision(spec);
    const registry = new FakeRegistry([
      { ...device("dev_ready", driverDevice.deviceId), state: "ready", quarantineNextRetryAt: 500 },
    ]);
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions: new SerializedDecision(),
      drivers: new DriverCatalog([driver]),
      eventBus: new EventBus(clock),
      notifyAvailability: vi.fn(),
      registry,
    });

    coordinator.restore();

    expect(clock.pendingTimerCount).toBe(0);
  });
});

/** Lets the microtask queue (the fire-and-forget retry chain) settle after a timer fires. */
async function flush(): Promise<void> {
  for (let count = 0; count < 100; count += 1) await Promise.resolve();
}

describe("QuarantineCoordinator for a physical device (ADR 0022 §4)", () => {
  const physicalRecord = {
    createdAt: 600,
    driverData: {},
    driverDeviceId: "00008110-001A2B3C4D5E",
    enrolledApps: [],
    id: "dev_physical",
    lastLeaseEndedAt: 700,
    physical: true,
    spec: {
      class: "phone",
      model: "iPhone 15 Pro",
      osVersion: "18.4",
      physical: true,
      platform: "ios",
    },
    state: "reclaiming",
  };

  async function physicalHarness(state: "reclaiming" | "quarantined") {
    const clock = new FakeClock(1_000);
    const bus = new EventBus(clock);
    const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(
      "/home/agent/.simlock/state.json",
      JSON.stringify({
        devices: [],
        leases: [],
        physicalDevices: [{ ...physicalRecord, quarantineNextRetryAt: 1_500, state }],
      }),
    );
    const registry = await Registry.load({
      clock,
      eventBus: bus,
      filesystem,
      idGenerator: { generate: () => "id" },
      statePath: "/home/agent/.simlock/state.json",
    });
    // A retry timer's first act is a serialized decision, so `decisionRuns` is the device's own
    // retry: the test compares it before and after the clock passes, not against a count of the
    // shared clock's timers.
    const decisions = new SerializedDecision();
    const decisionRuns = vi.spyOn(decisions, "run");
    const coordinator = new QuarantineCoordinator({
      claims: new DeviceOperationClaims(),
      clock,
      config: retryConfig,
      decisions,
      drivers: new DriverCatalog([driver]),
      eventBus: bus,
      notifyAvailability: vi.fn(),
      registry,
    });
    const driverCalls = vi.spyOn(driver, "reclaim");
    return { bus, clock, coordinator, decisionRuns, driver, driverCalls, registry };
  }

  it("commits quarantined for a stalled physical device and arms no retry, though the event and the record carry nextRetryAt", async () => {
    const harness = await physicalHarness("reclaiming");

    await harness.coordinator.enterFromStalledTransition("dev_physical");
    const runsAfterEntry = harness.decisionRuns.mock.calls.length;
    harness.clock.advance(60_000);
    await flush();

    expect(harness.decisionRuns).toHaveBeenCalledTimes(runsAfterEntry);
    expect(harness.registry.snapshot.devices[0]).toMatchObject({
      quarantineNextRetryAt: 2_000,
      state: "quarantined",
    });
    expect(harness.driverCalls).not.toHaveBeenCalled();
    expect(eventsOf(harness.bus).map((event) => event.event)).toEqual(["device.quarantined"]);
    expect(eventsOf(harness.bus)[0]?.payload).toMatchObject({ nextRetryAt: 2_000 });
  });

  it("arms no retry for a physical device quarantined by a purge failure either", async () => {
    const harness = await physicalHarness("reclaiming");

    await harness.coordinator.enter({
      attemptedStrategy: "erase",
      deviceId: "dev_physical",
      duration: 5,
      error: "Error: uninstall failed",
      leaseId: "lse_1",
    });

    const runsAfterEntry = harness.decisionRuns.mock.calls.length;
    harness.clock.advance(60_000);
    await flush();

    expect(harness.decisionRuns).toHaveBeenCalledTimes(runsAfterEntry);
    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");
    expect(harness.driverCalls).not.toHaveBeenCalled();
  });

  it("arms no timer for a quarantined physical device when it restores, and leaves it quarantined", async () => {
    const harness = await physicalHarness("quarantined");

    const runsBefore = harness.decisionRuns.mock.calls.length;
    harness.coordinator.restore();
    harness.clock.advance(60_000);
    await flush();

    expect(harness.decisionRuns).toHaveBeenCalledTimes(runsBefore);
    expect(harness.driverCalls).not.toHaveBeenCalled();
    expect(harness.registry.snapshot.devices[0]?.state).toBe("quarantined");
  });
});

describe("QuarantineCoordinator retry claim (ADR 0022 §2)", () => {
  async function stalled(options: Parameters<typeof createHarness>[0] = {}) {
    const clock = options.clock ?? new FakeClock(1_000);
    const harness = await createHarness({ ...options, clock });
    await harness.coordinator.enterFromStalledTransition(harness.target.id);
    return harness;
  }

  it("makes no driver call and keeps its attempt count when its claim is held, then runs one retryBackoffMs later", async () => {
    const harness = await stalled();
    const held = harness.claims.tryClaim(harness.target.id, "enrollment");

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toEqual([]);
    expect(harness.registry.snapshot.virtualDevices[0]).toMatchObject({
      quarantineAttempts: 0,
      state: "quarantined",
    });
    held?.release();
    harness.clock.advance(retryConfig.retryBackoffMs - 1);
    await flush();
    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toEqual([]);
    harness.clock.advance(1);
    await flush();

    expect(harness.driver.calls.filter((call) => call.operation === "reclaim")).toHaveLength(1);
    expect(eventsOf(harness.bus).at(-1)).toMatchObject({
      event: "device.quarantine-recovered",
      payload: { attempts: 1 },
    });
  });

  it.each([
    ["succeeds", false],
    ["throws", true],
  ] as const)(
    "holds the reclaim claim while the driver's reclaim runs, and frees it after the call %s",
    async (_case, throws) => {
      const clock = new FakeClock(1_000);
      const driver = new FakeDriver({ clock, platform: "ios", reclaimResult: "ready" });
      if (throws) driver.failOn("reclaim", 1, new Error("still stuck"));
      const harness = await stalled({ clock, driver });
      const original = driver.reclaim.bind(driver);
      const duringCall: unknown[] = [];
      vi.spyOn(driver, "reclaim").mockImplementation(async (device, options) => {
        duringCall.push(harness.claims.operationFor(harness.target.id));
        return original(device, options);
      });

      harness.clock.advance(retryConfig.retryBackoffMs);
      await flush();

      expect(duringCall).toEqual(["reclaim"]);
      expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
      expect(harness.registry.snapshot.virtualDevices[0]?.state).toBe(
        throws ? "quarantined" : "ready",
      );
    },
  );

  it("has freed the claim before it emits and before it wakes availability when a retry recovers the device", async () => {
    const harness = await stalled({});
    const claimedAt: boolean[] = [];
    const sees = () => claimedAt.push(harness.claims.isClaimed(harness.target.id));
    harness.bus.subscribe("device.quarantine-recovered", sees);
    harness.notifyAvailability.mockImplementation(sees);

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.notifyAvailability).toHaveBeenCalledTimes(1);
    expect(claimedAt).toEqual([false, false]);
  });

  it("has freed the claim before it wakes availability when a retry deletes a spent fresh device", async () => {
    const harness = await stalled({ target: { lastLeaseEndedAt: 900, leaseIdentity: "fresh" } });
    const claimedAt: boolean[] = [];
    harness.notifyAvailability.mockImplementation(() =>
      claimedAt.push(harness.claims.isClaimed(harness.target.id)),
    );

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.registry.snapshot.virtualDevices.map((device) => device.state)).toEqual([
      "deleted",
    ]);
    expect(claimedAt).toEqual([false]);
  });

  it("has freed the claim before it emits device.quarantine-abandoned and before it wakes availability when a retry gives up", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    const harness = await stalled({ clock, driver });
    const claimedAt: boolean[] = [];
    const sees = () => claimedAt.push(harness.claims.isClaimed(harness.target.id));
    harness.bus.subscribe("device.quarantine-abandoned", sees);
    harness.notifyAvailability.mockImplementation(sees);

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(eventsOf(harness.bus).at(-1)?.event).toBe("device.quarantine-abandoned");
    expect(claimedAt).toEqual([false, false]);
  });

  it("has freed the claim before it emits device.quarantine-stranded when a retry gives up and cannot destroy the device", async () => {
    const clock = new FakeClock(1_000);
    const driver = new FakeDriver({ clock, platform: "ios" });
    driver.failOn("reclaim", 1, new Error("still stuck"));
    driver.failOn("reclaim", 2, new Error("still stuck"));
    driver.failOn("destroy", 1, new Error("cannot destroy"));
    const harness = await stalled({ clock, driver });
    const claimedAt: boolean[] = [];
    harness.bus.subscribe("device.quarantine-stranded", () =>
      claimedAt.push(harness.claims.isClaimed(harness.target.id)),
    );

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();
    harness.clock.advance(2_000);
    await flush();

    expect(claimedAt).toEqual([false]);
  });

  it("frees the claim when a registry write throws during the retry", async () => {
    const harness = await stalled();
    vi.spyOn(harness.registry, "recoverFromQuarantine").mockRejectedValue(new Error("disk full"));

    harness.clock.advance(retryConfig.retryBackoffMs);
    await flush();

    expect(harness.claims.isClaimed(harness.target.id)).toBe(false);
  });
});
