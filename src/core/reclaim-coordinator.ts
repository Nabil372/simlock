import type { EventBus } from "../bus/index.js";
import type { Clock, Logger } from "../ports/index.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import {
  type AbsentReason,
  assertVirtual,
  type DeviceRecord,
  type DeviceTransitionUpdate,
  type LeaseRecord,
  mayBeGranted,
  type PhysicalDevice,
  type Platform,
  type VirtualDevice,
} from "./domain.js";
import { type Driver, toDriverDevice } from "./driver.js";
import { readPhysicalPresenceDetail } from "./physical-presence.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

export interface ReclaimDriverCatalog {
  get(platform: Platform): Driver;
}

export interface ReclaimRegistry {
  readonly snapshot: {
    readonly devices: readonly DeviceRecord[];
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
  transitionDevice(
    deviceId: string,
    to: "ready" | "shutdown" | "deleted" | "reclaiming" | "absent",
    event:
      | {
          readonly event: "device.absence-detected";
          readonly payload: {
            readonly deviceId: string;
            readonly previousState: "reclaiming";
            readonly absentReason: AbsentReason;
          };
        }
      | {
          readonly event: "device.returned";
          readonly payload: { readonly deviceId: string; readonly osVersion: string };
        }
      | {
          readonly event: "device.reclaimed";
          readonly payload: {
            readonly deviceId: string;
            readonly duration: number;
            readonly strategy: "erase" | "snapshot" | "wipe" | "uninstall";
            readonly missingApps?: readonly string[];
          };
        }
      | {
          readonly event: "device.deleted";
          readonly payload: { readonly deviceId: string; readonly initiator: string };
        },
    update?: DeviceTransitionUpdate,
  ): Promise<DeviceRecord>;
  completeReclaimWithoutPurge(deviceId: string): Promise<DeviceRecord>;
}

export interface ReclaimQuarantine {
  enter(failure: QuarantinePurgeFailure): Promise<void>;
}

export interface ReclaimCoordinatorOptions {
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly clock: Clock;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: ReclaimDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly logger?: Logger | undefined;
  readonly notifyAvailability: () => void;
  /** Called once a physical device's reclaim has committed it `ready`. */
  readonly physicalDeviceReady?: (deviceId: string) => void;
  readonly quarantine: ReclaimQuarantine;
  readonly registry: ReclaimRegistry;
}

export class ReclaimCoordinator {
  readonly #backgroundWipes = new Set<Promise<void>>();

  constructor(private readonly options: ReclaimCoordinatorOptions) {}

  async settle(): Promise<void> {
    while (this.#backgroundWipes.size > 0) {
      await Promise.allSettled(this.#backgroundWipes);
    }
  }

  // Not `async`: returning the inner promise adds no microtask hop to a reclaim's start, and
  // the tests that step a fake clock count those hops.
  reclaim(released: ReleasedLease): Promise<void> {
    // A physical device is never retired: it has no spent state, so only its purge applies.
    if (released.device.physical) return this.#purge(released.device, released.lease.id);
    if (!mayBeGranted(released.device)) {
      return this.#retireSpent({ device: released.device, lease: released.lease });
    }
    return this.#purge(released.device, released.lease.id);
  }

  async #purge(device: DeviceRecord, leaseId?: string): Promise<void> {
    const driver = this.options.drivers.get(device.spec.platform);
    const startedAt = this.options.clock.now();
    const attemptedStrategy = driver.reclaimStrategy(toDriverDevice(device), { clean: "standard" });
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch (error: unknown) {
      if (device.physical && (await this.#absentAfterFailure(device, error))) return;
      await this.#recoverPurgeFailure(device.id, leaseId, startedAt, attemptedStrategy, error);
      return;
    }

    await this.options.decisions.run(async () => {
      await this.options.registry.transitionDevice(device.id, result.state, {
        event: "device.reclaimed",
        payload: {
          deviceId: device.id,
          duration: this.options.clock.now() - startedAt,
          strategy: result.strategy,
          ...(result.missingApps === undefined ? {} : { missingApps: result.missingApps }),
        },
      });
    });
    if (device.physical && result.state === "ready") this.options.physicalDeviceReady?.(device.id);
    this.options.notifyAvailability();
  }

  /** The wipe starts in the background under a claim and this returns once it has started: an erase runs tens of seconds, and startup waits for none. */
  async recoverInterrupted(deviceId: string): Promise<boolean> {
    const device = await this.options.decisions.run(async () => {
      const current = this.options.registry.snapshot.virtualDevices.find(
        (candidate) => candidate.id === deviceId,
      );
      const leased = this.options.registry.snapshot.leases.some(
        (lease) => lease.deviceId === deviceId,
      );
      return current?.state === "reclaiming" && !leased ? current : undefined;
    });
    if (device === undefined) return false;

    if (device.deferredReclaimLeaseId !== undefined && mayBeGranted(device)) {
      const claim = this.options.claims.tryClaim(device.id, "reclaim");
      if (claim === undefined) return false;
      this.#wipeInBackground(device, claim, device.deferredReclaimLeaseId);
      return true;
    }

    await this.options.drivers.get(device.spec.platform).shutdown(toDriverDevice(device));
    const recovered = await this.options.decisions.run(async () => {
      const current = this.options.registry.snapshot.virtualDevices.find(
        (candidate) => candidate.id === deviceId,
      );
      const leased = this.options.registry.snapshot.leases.some(
        (lease) => lease.deviceId === deviceId,
      );
      if (current?.state !== "reclaiming" || leased) return false;
      await this.options.registry.completeReclaimWithoutPurge(deviceId);
      this.options.eventBus.emit(
        "device.shutdown",
        { deviceId, initiator: "startup-interrupted-reclaim" },
        "warm-pool-coordinator",
      );
      return true;
    });
    if (recovered) this.options.notifyAvailability();
    return recovered;
  }

  /**
   * Runs the reclaim of a physical device the watcher found back, or one a killed daemon left
   * `reclaiming` (ADR 0022 §8), in the background under a `reclaim` claim taken here. With
   * `osVersion` the device is `absent` and comes back: one decision checks that and commits
   * `absent -> reclaiming` with the new OS version. Without it the device is already
   * `reclaiming` and nothing is written. A claim held, or a device no longer in that state,
   * means there is nothing to do: false. The returned promise settles once the reclaim has
   * started; the reclaim itself is awaited by `settle`.
   */
  async reclaimReturned(deviceId: string, osVersion?: string): Promise<boolean> {
    const known = this.#physicalDevice(deviceId);
    if (known === undefined) return false;
    const claim = this.options.claims.tryClaim(known.id, "reclaim");
    if (claim === undefined) return false;
    let device: PhysicalDevice | undefined;
    try {
      device = await this.options.decisions.run(() => this.#beginReturned(known.id, osVersion));
    } finally {
      if (device === undefined) claim.release();
    }
    if (device === undefined) return false;
    this.#wipeInBackground(device, claim);
    return true;
  }

  /** The enrolled physical record a registry ID, or the canonical ID of its device, names. */
  #physicalDevice(id: string): PhysicalDevice | undefined {
    return this.options.registry.snapshot.devices.find(
      (candidate): candidate is PhysicalDevice =>
        candidate.physical && (candidate.id === id || candidate.driverDeviceId === id),
    );
  }

  async #beginReturned(
    deviceId: string,
    osVersion: string | undefined,
  ): Promise<PhysicalDevice | undefined> {
    const current = this.#physicalDevice(deviceId);
    if (current === undefined) return undefined;
    if (osVersion === undefined) {
      const leased = this.options.registry.snapshot.leases.some(
        (lease) => lease.deviceId === current.id,
      );
      return current.state === "reclaiming" && !leased ? current : undefined;
    }
    if (current.state !== "absent") return undefined;
    const returned = await this.options.registry.transitionDevice(
      current.id,
      "reclaiming",
      { event: "device.returned", payload: { deviceId: current.id, osVersion } },
      { osVersion },
    );
    return returned as PhysicalDevice;
  }

  /**
   * Starts the wipe under a claim already held and leaves it running. The claim is released,
   * and a failure logged rather than thrown, once the wipe settles: no caller awaits it. A
   * driver failure never gets that far, since `#purge` hands it to quarantine.
   */
  #wipeInBackground(device: DeviceRecord, claim: DeviceOperationClaim, leaseId?: string): void {
    const wipe = this.#purge(device, leaseId)
      .catch((error: unknown) => {
        this.options.logger?.error("deferred wipe failed", {
          deviceId: device.id,
          error: error instanceof Error ? error.message : String(error),
          leaseId,
        });
      })
      .finally(() => {
        claim.release();
        this.options.notifyAvailability();
      });
    this.#backgroundWipes.add(wipe);
    void wipe.finally(() => this.#backgroundWipes.delete(wipe));
  }

  /**
   * Finishes a spent fresh device found `shutdown` at startup: the daemon stopped after its
   * lease-end shutdown committed and before its delete did. A delete that fails throws and
   * leaves the device `shutdown`, where `mayBeGranted` still keeps it out of every grant.
   */
  async deleteSpent(deviceId: string): Promise<boolean> {
    const device = await this.options.decisions.run(async () => {
      const current = this.#unleasedDevice(deviceId, "shutdown");
      return current === undefined || mayBeGranted(current) ? undefined : current;
    });
    if (device === undefined) return false;
    return this.#deleteSpent(device);
  }

  /**
   * A spent fresh device is never purged and never returns to the pool. Its lease end is a
   * driver shutdown, a `reclaiming -> shutdown` commit with no `device.reclaimed` (nothing was
   * reclaimed), then the delete. Either driver step failing hands the device to quarantine,
   * which retries the delete.
   */
  async #retireSpent(released: {
    readonly device: VirtualDevice;
    readonly lease: LeaseRecord;
  }): Promise<void> {
    const driver = this.options.drivers.get(released.device.spec.platform);
    const startedAt = this.options.clock.now();
    try {
      await driver.shutdown(toDriverDevice(released.device));
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(
        released.device.id,
        released.lease.id,
        startedAt,
        "delete",
        error,
      );
      return;
    }
    const shutdown = await this.options.decisions.run(async () =>
      assertVirtual(await this.options.registry.completeReclaimWithoutPurge(released.device.id)),
    );
    // Running capacity is free from here; the device itself stays ungrantable.
    this.options.notifyAvailability();

    try {
      await this.#deleteSpent(shutdown);
    } catch (error: unknown) {
      await this.#recoverPurgeFailure(
        released.device.id,
        released.lease.id,
        startedAt,
        "delete",
        error,
      );
    }
  }

  /** Destroys a spent device and commits `shutdown -> deleted`, if it is still that device. */
  async #deleteSpent(device: VirtualDevice): Promise<boolean> {
    await this.options.drivers.get(device.spec.platform).destroy(toDriverDevice(device));
    const deleted = await this.options.decisions.run(async () => {
      if (this.#unleasedDevice(device.id, "shutdown") === undefined) return false;
      await this.options.registry.transitionDevice(device.id, "deleted", {
        event: "device.deleted",
        payload: { deviceId: device.id, initiator: "lease-end" },
      });
      return true;
    });
    if (deleted) this.options.notifyAvailability();
    return deleted;
  }

  #unleasedDevice(deviceId: string, state: DeviceRecord["state"]): VirtualDevice | undefined {
    const { leases, virtualDevices } = this.options.registry.snapshot;
    const current = virtualDevices.find((candidate) => candidate.id === deviceId);
    if (current?.state !== state || leases.some((lease) => lease.deviceId === deviceId)) {
      return undefined;
    }
    return current;
  }

  /**
   * Hands the release-time purge failure to the quarantine coordinator instead
   * of readiness-checking the device back into circulation: the first warm-pool
   * version did that (see docs/internal/KNOWN-PITFALLS.md) so a dirty device could still
   * be leased, which is exactly the confusing failure mode quarantine replaces.
   */
  async #recoverPurgeFailure(
    deviceId: string,
    leaseId: string | undefined,
    startedAt: number,
    attemptedStrategy: QuarantinePurgeFailure["attemptedStrategy"],
    error: unknown,
  ): Promise<void> {
    await this.options.quarantine.enter({
      attemptedStrategy,
      deviceId,
      duration: this.options.clock.now() - startedAt,
      error: stableError(error),
      leaseId,
    });
  }

  /**
   * A physical reclaim that failed is read once more (task 2 quarantines every failure): a device
   * that is not present, or whose read could not be made, is `absent` and not `quarantined`, since
   * its reclaim runs again when it is back. A present device falls through to quarantine.
   */
  async #absentAfterFailure(device: PhysicalDevice, error: unknown): Promise<boolean> {
    let absentReason: AbsentReason | undefined;
    try {
      const driver = this.options.drivers.get(device.spec.platform);
      const reads = await readPhysicalPresenceDetail(driver, [device.driverDeviceId]);
      const read = reads.get(device.driverDeviceId);
      if (read?.present !== true) absentReason = read?.reason ?? "not-present";
    } catch (readError: unknown) {
      this.options.logger?.warn("presence read after a failed reclaim failed", {
        deviceId: device.id,
        error: stableError(readError),
      });
      absentReason = "not-present";
    }
    if (absentReason === undefined) return false;
    const reason = absentReason;
    this.options.logger?.error("reclaim of a device that is not present failed", {
      deviceId: device.id,
      error: stableError(error),
    });
    await this.options.decisions.run(async () => {
      await this.options.registry.transitionDevice(
        device.id,
        "absent",
        {
          event: "device.absence-detected",
          payload: { absentReason: reason, deviceId: device.id, previousState: "reclaiming" },
        },
        { absentReason: reason },
      );
    });
    return true;
  }
}
