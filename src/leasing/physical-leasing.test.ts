import { describe, expect, it, vi } from "vitest";
import {
  type DeviceRequest,
  type LeaseGrant,
  type LeaseProgress,
  NoDriverError,
  type Config,
  type PhysicalDevice,
  Registry,
  UnknownModelError,
} from "../core/index.js";
import { FakeDriver, testComponentWiring } from "../core/testing.js";
import { EventBus, type EventMap } from "../bus/index.js";
import { FakeClock, FakeSystemStats, MemoryFilesystem } from "../ports/index.js";
import { NoCapacityError } from "./lease-acquisition-coordinator.js";
import { createTestEngine } from "./testing.js";
import { QueueTimeoutError, RequestCancelledError } from "./wait-queue.js";

const gibibyte = 1024 ** 3;
const statePath = "/home/agent/.simlock/state.json";

const physicalRequest = {
  model: "iPhone 15 Pro",
  physical: true,
  platform: "ios",
} as const satisfies DeviceRequest;

function config(): Config {
  return {
    mode: "worker",
    exec: { timeoutMs: 600_000 },
    diskPressure: { freeBytesThreshold: 10 * gibibyte },
    gateway: {
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free" as const,
    },
    drivers: {},
    downloads: { acceptAndroidLicenses: false, policy: "on-request", timeoutMs: 1_200_000 },
    eventBuffer: { capacity: 100 },
    http: { enabled: false, host: "127.0.0.1", port: 4700 },
    ios: { defaultMode: "full", defaultModels: {}, slim: { bootTimeoutMs: 600_000 } },
    android: {
      defaultModels: {},
      emulator: { headless: false, gpu: "auto", audio: true, bootAnimation: true },
    },
    health: {
      enabled: true,
      maxConcurrentRecoveries: 1,
      maxRecoveryAttempts: 3,
      probeIntervalMs: 30_000,
      recoveryBackoffMs: 5_000,
      stableObservations: 2,
    },
    stalledTransition: { thresholdMultiplier: 3, minimumThresholdMs: 60_000 },
    idle: { deleteAfterMs: 60_000, shutdownAfterMs: 10_000 },
    lease: {
      defaultTtlMs: 3_600_000,
      maxTtlMs: 14_400_000,
      identity: { ios: "reusable", android: "reusable" },
      requestRetentionMs: 600_000,
      maxRequestRecords: 10_000,
    },
    capacity: {
      strategy: "resource",
      config: {
        limits: {
          android: { maxDevices: 1, maxRunning: 1 },
          ios: { maxDevices: 1, maxRunning: 1 },
          maxRunning: 2,
        },
        ramBudget: { androidBytesPerDevice: 4 * gibibyte, iosBytesPerDevice: gibibyte },
      },
    },
    log: { level: "info", rotateBytes: 5 * 1024 * 1024 },
    eventLog: {
      rotateBytes: 5 * 1024 * 1024,
      retention: 7 * 24 * 60 * 60 * 1000,
      maxBytes: 256 * 1024 * 1024,
    },
    warmPool: {
      enabled: false,
      maxConcurrentBoots: 1,
      reserveRunning: { android: 0, ios: 0 },
      targets: [],
      quarantine: {
        maxRetries: 3,
        maxRetryBackoffMs: 300_000,
        retryBackoffMs: 30_000,
        retryBackoffMultiplier: 2,
      },
    },
  };
}

async function createHarness(options: { readonly reclaimEstimateMs?: number } = {}) {
  const clock = new FakeClock(1_000);
  const bus = new EventBus(clock);
  const driver = new FakeDriver({
    availableOsVersions: ["26.5"],
    clock,
    ...(options.reclaimEstimateMs === undefined
      ? {}
      : { estimateMs: { reclaim: options.reclaimEstimateMs } }),
    platform: "ios",
  });
  let nextId = 1;
  const registry = await Registry.load({
    clock,
    eventBus: bus,
    filesystem: new MemoryFilesystem(),
    idGenerator: { generate: () => `${nextId++}` },
    statePath,
  });
  const engine = createTestEngine({
    ...testComponentWiring({ clock, drivers: [driver], eventBus: bus, registry }),
    clock,
    config: config(),
    drivers: [driver],
    eventBus: bus,
    idGenerator: { generate: () => `request-${nextId++}` },
    registry,
    systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * gibibyte }),
  });
  return { bus, clock, driver, engine, registry };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function enrollIphone(harness: Harness, driverDeviceId: string): Promise<PhysicalDevice> {
  const device = await harness.registry.enrollPhysical({
    apps: [],
    class: "phone",
    driverDeviceId,
    model: "iPhone 15 Pro",
    osVersion: "18.4",
    platform: "ios",
  });
  harness.driver.setPhysicalPresence(driverDeviceId, true);
  return device;
}

async function startReclaiming(harness: Harness, device: PhysicalDevice): Promise<void> {
  await harness.registry.transitionDevice(device.id, "leased");
  await harness.registry.transitionDevice(device.id, "reclaiming");
}

async function finishReclaim(harness: Harness, device: PhysicalDevice): Promise<void> {
  await harness.registry.transitionDevice(device.id, "ready", {
    event: "device.reclaimed",
    payload: { deviceId: device.id, duration: 0, strategy: "uninstall" },
  });
}

function asking(requesterId: string, extra: object = {}) {
  return { ownerId: requesterId, requesterId, ...extra };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 500; count += 1) {
    await Promise.resolve();
  }
}

/** The grant or error `promise` settles with within a flush, or "pending". */
async function outcome(promise: Promise<LeaseGrant>): Promise<LeaseGrant | Error | "pending"> {
  return Promise.race([
    promise.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
    flush().then(() => "pending" as const),
  ]);
}

function eventsNamed<Name extends keyof EventMap>(harness: Harness, name: Name) {
  return harness.bus.replay().filter((event) => event.event === name);
}

function stateOf(harness: Harness, device: PhysicalDevice): string | undefined {
  return harness.registry.snapshot.devices.find((candidate) => candidate.id === device.id)?.state;
}

function presenceReads(harness: Harness): unknown[] {
  return harness.driver.calls
    .filter((call) => call.operation === "listPresentPhysical")
    .map((call) => call.arguments[0]);
}

function claimKind(harness: Harness, device: PhysicalDevice): string | undefined {
  return harness.engine.core.claims.claim(device.id)?.kind;
}

/**
 * A request queued behind a reclaiming device, whose device then turns ready and whose queue
 * wake-up starts a presence read that is held.
 */
async function waiterMidPresenceRead(options: { readonly timeoutMs?: number } = {}) {
  const harness = await createHarness();
  const device = await enrollIphone(harness, "UDID-A");
  await startReclaiming(harness, device);
  harness.driver.holdPresenceReads("UDID-A");
  const promise = harness.engine.request(physicalRequest, asking("agent", options));
  await flush();
  await finishReclaim(harness, device);
  harness.engine.leasing.corePorts.notifyAvailability();
  await flush();
  return { device, harness, promise };
}

describe("createLeasing with physical devices", () => {
  it("carries requestSpec.physical true on lease.requested of a physical request, lease.rejected of one nothing could match, and lease.declined of a probe nothing could match", async () => {
    const harness = await createHarness();

    const refused = harness.engine.request(physicalRequest, asking("agent"));
    const probe = harness.engine.request(
      physicalRequest,
      asking("gateway", { fleetRequestId: "fleet_1", noWait: true }),
    );
    await outcome(refused);
    await outcome(probe);

    expect(eventsNamed(harness, "lease.requested")).toMatchObject([
      { payload: { requestSpec: { physical: true } } },
      { payload: { requestSpec: { physical: true } } },
    ]);
    expect(eventsNamed(harness, "lease.rejected")).toMatchObject([
      { payload: { reason: "unresolvable-spec", requestSpec: { physical: true } } },
    ]);
    expect(eventsNamed(harness, "lease.declined")).toMatchObject([
      {
        payload: {
          fleetRequestId: "fleet_1",
          reason: "unresolvable-spec",
          requestSpec: { physical: true },
        },
      },
    ]);
  });

  it("ends a physical request for a platform with no driver NO_DRIVER, lease.rejected unresolvable-spec", async () => {
    const harness = await createHarness();

    const result = await outcome(
      harness.engine.request({ ...physicalRequest, platform: "android" }, asking("agent")),
    );

    expect(result).toBeInstanceOf(NoDriverError);
    expect(eventsNamed(harness, "lease.rejected")).toMatchObject([
      { payload: { reason: "unresolvable-spec", requestSpec: { physical: true } } },
    ]);
  });

  it("makes no listCatalog and no resolveSpec call on the fake driver for a physical request, granted or refused", async () => {
    const lookups = (harness: Harness) =>
      harness.driver.calls
        .map((call) => call.operation)
        .filter((operation) => operation === "listCatalog" || operation === "resolveSpec");
    const granting = await createHarness();
    const device = await enrollIphone(granting, "UDID-A");
    const refusing = await createHarness();

    const granted = await outcome(granting.engine.request(physicalRequest, asking("agent")));
    const refused = await outcome(
      refusing.engine.request(
        { class: "tablet", physical: true, platform: "ios" },
        asking("agent"),
      ),
    );

    expect(lookups(granting)).toEqual([]);
    expect(lookups(refusing)).toEqual([]);
    expect(granted).toMatchObject({ device: { id: device.id } });
    expect(refused).toBeInstanceOf(UnknownModelError);
  });

  it("counts a presence read that rejects as not present and releases the grant claim", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.failOn("listPresentPhysical", 1, new Error("adb: device offline"));

    const result = await outcome(
      harness.engine.request(physicalRequest, asking("agent", { noWait: true })),
    );

    expect(result).toBeInstanceOf(NoCapacityError);
    expect(presenceReads(harness)).toEqual([["UDID-A"]]);
    expect(harness.engine.core.claims.isClaimed(device.id)).toBe(false);
    expect(stateOf(harness, device)).toBe("ready");
  });

  it("does not grant a device whose state changed during its presence read, and plans the waiter again", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    harness.driver.holdPresenceReads("UDID-A");

    const promise = harness.engine.request(physicalRequest, asking("agent"));
    await flush();
    expect(claimKind(harness, first)).toBe("grant");
    await harness.registry.transitionDevice(first.id, "leased");
    harness.driver.releasePresenceReads();
    const result = await outcome(promise);

    expect(result).toMatchObject({ device: { id: second.id } });
    expect(presenceReads(harness)).toEqual([["UDID-A"], ["UDID-B"]]);
    expect(stateOf(harness, first)).toBe("leased");
    expect(harness.engine.core.claims.isClaimed(first.id)).toBe(false);
  });

  it("does not let a new physical request take a ready device that an older queued physical request matches", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    harness.driver.setPhysicalPresence("UDID-A", false);
    const older = harness.engine.request(physicalRequest, asking("older"));
    expect(await outcome(older)).toBe("pending");
    harness.driver.setPhysicalPresence("UDID-A", true);

    const newer = await outcome(
      harness.engine.request(physicalRequest, asking("newer", { noWait: true })),
    );

    expect(newer).toBeInstanceOf(NoCapacityError);
    expect(stateOf(harness, device)).toBe("ready");
    expect(harness.driver.calls.map((call) => call.operation)).not.toContain("provision");
    harness.engine.leasing.corePorts.notifyAvailability();
    expect(await outcome(older)).toMatchObject({ device: { id: device.id } });
  });

  it("grants a new physical request a ready device that an older physical request also matches while the older one is mid presence read for another device", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    harness.driver.holdPresenceReads("UDID-A");
    const older = harness.engine.request(physicalRequest, asking("older"));
    await flush();
    expect(claimKind(harness, first)).toBe("grant");

    const newer = await outcome(harness.engine.request(physicalRequest, asking("newer")));
    harness.driver.releasePresenceReads();

    expect(newer).toMatchObject({ device: { id: second.id } });
    expect(await outcome(older)).toMatchObject({ device: { id: first.id } });
  });

  it("gives no reclaiming progress stage to a physical waiter whose only match is reclaiming", async () => {
    const harness = await createHarness({ reclaimEstimateMs: 34_000 });
    const device = await enrollIphone(harness, "UDID-A");
    await startReclaiming(harness, device);
    const progress: LeaseProgress[] = [];

    const result = await outcome(
      harness.engine.request(
        physicalRequest,
        asking("agent", { onProgress: (update: LeaseProgress) => progress.push(update) }),
      ),
    );

    expect(result).toBe("pending");
    expect(progress).toEqual([{ queuePosition: 1, stage: "queued" }]);
    expect(stateOf(harness, device)).toBe("reclaiming");
  });

  it("grants both of two queued physical requests that match two devices that become ready at once: the first grant wakes the queue", async () => {
    const harness = await createHarness();
    const first = await enrollIphone(harness, "UDID-A");
    const second = await enrollIphone(harness, "UDID-B");
    await startReclaiming(harness, first);
    await startReclaiming(harness, second);
    const older = harness.engine.request(physicalRequest, asking("older"));
    const newer = harness.engine.request(physicalRequest, asking("newer"));
    await flush();
    await finishReclaim(harness, first);
    await finishReclaim(harness, second);

    harness.engine.leasing.corePorts.notifyAvailability();
    const results = [await outcome(older), await outcome(newer)];

    expect(results).toMatchObject([{ device: { id: first.id } }, { device: { id: second.id } }]);
  });

  it("does not grant a waiter that times out, is cancelled, or is killed by nuke during its presence read: the device stays ready and the grant claim is released", async () => {
    const timedOut = await waiterMidPresenceRead({ timeoutMs: 1_000 });
    expect(claimKind(timedOut.harness, timedOut.device)).toBe("grant");
    timedOut.harness.clock.advance(1_000);
    timedOut.harness.driver.releasePresenceReads();
    expect(await outcome(timedOut.promise)).toBeInstanceOf(QueueTimeoutError);
    expect(stateOf(timedOut.harness, timedOut.device)).toBe("ready");
    expect(timedOut.harness.engine.core.claims.isClaimed(timedOut.device.id)).toBe(false);

    const cancelled = await waiterMidPresenceRead();
    expect(claimKind(cancelled.harness, cancelled.device)).toBe("grant");
    expect(await cancelled.harness.engine.cancelPending("agent")).toBe("cancelled");
    cancelled.harness.driver.releasePresenceReads();
    expect(await outcome(cancelled.promise)).toBeInstanceOf(RequestCancelledError);
    expect(stateOf(cancelled.harness, cancelled.device)).toBe("ready");
    expect(cancelled.harness.engine.core.claims.isClaimed(cancelled.device.id)).toBe(false);

    const killed = await waiterMidPresenceRead();
    expect(claimKind(killed.harness, killed.device)).toBe("grant");
    const nuking = killed.harness.engine.nuke(false);
    expect(await outcome(killed.promise)).toBeInstanceOf(Error);
    killed.harness.driver.releasePresenceReads();
    await nuking;
    expect(killed.harness.registry.snapshot.leases).toEqual([]);
    expect(stateOf(killed.harness, killed.device)).toBe("ready");
    expect(killed.harness.engine.core.claims.isClaimed(killed.device.id)).toBe(false);
  });

  it("releases the grant claim and leaves the device ready when the lease write of a physical grant throws", async () => {
    const harness = await createHarness();
    const device = await enrollIphone(harness, "UDID-A");
    const createLease = vi
      .spyOn(harness.registry, "createLease")
      .mockRejectedValueOnce(new Error("disk full"));

    const result = await outcome(harness.engine.request(physicalRequest, asking("agent")));
    await flush();

    expect(createLease).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id }));
    expect(result).not.toMatchObject({ lease: expect.anything() });
    expect(harness.engine.core.claims.isClaimed(device.id)).toBe(false);
    expect(stateOf(harness, device)).toBe("ready");
    expect(harness.registry.snapshot.leases).toEqual([]);
  });

  it("declines a probe for a physical request nothing could match unresolvable-spec, and one whose matches are all leased no-wait", async () => {
    const none = await createHarness();
    const unmatched = await outcome(
      none.engine.request(
        physicalRequest,
        asking("gateway", { fleetRequestId: "fleet_1", noWait: true }),
      ),
    );
    const busy = await createHarness();
    await enrollIphone(busy, "UDID-A");
    await busy.engine.request(physicalRequest, asking("holder"));
    const leased = await outcome(
      busy.engine.request(
        physicalRequest,
        asking("gateway", { fleetRequestId: "fleet_2", noWait: true }),
      ),
    );

    expect(unmatched).toBeInstanceOf(UnknownModelError);
    expect(eventsNamed(none, "lease.declined")).toMatchObject([
      { payload: { fleetRequestId: "fleet_1", reason: "unresolvable-spec" } },
    ]);
    expect(leased).toBeInstanceOf(NoCapacityError);
    expect(eventsNamed(busy, "lease.declined")).toMatchObject([
      { payload: { fleetRequestId: "fleet_2", reason: "no-wait" } },
    ]);
  });
});
