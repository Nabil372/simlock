import type { EventBus } from "../bus/index.js";
import type { Clock, Logger } from "../ports/index.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
import {
  assertVirtual,
  type DeviceRecord,
  type LeaseRecord,
  mayBeGranted,
  type Platform,
  type VirtualDevice,
} from "./domain.js";
import { type Driver, toDriverDevice } from "./driver.js";
import type { QuarantinePurgeFailure } from "./quarantine-coordinator.js";
import type { ReleasedLease } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

export interface ReclaimDriverCatalog {
  get(platform: Platform): Driver;
}

export interface ReclaimRegistry {
  readonly snapshot: {
    readonly virtualDevices: readonly VirtualDevice[];
    readonly leases: readonly LeaseRecord[];
  };
  transitionDevice(
    deviceId: string,
    to: "ready" | "shutdown" | "deleted",
    event:
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

  async #purge(device: DeviceRecord, leaseId: string): Promise<void> {
    const driver = this.options.drivers.get(device.spec.platform);
    const startedAt = this.options.clock.now();
    const attemptedStrategy = driver.reclaimStrategy(toDriverDevice(device), { clean: "standard" });
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch (error: unknown) {
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
      return this.#wipeInBackground(device, device.deferredReclaimLeaseId);
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
   * Starts the wipe under a claim and leaves it running. A claim already held means another
   * operation has the device, so there is nothing to recover. The claim is released, and a
   * failure logged rather than thrown, once the wipe settles: no caller awaits it. A driver
   * failure never gets that far, since `#purge` hands it to quarantine.
   */
  #wipeInBackground(device: VirtualDevice, leaseId: string): boolean {
    const claim = this.options.claims.tryClaim(device.id, "reclaim");
    if (claim === undefined) return false;
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
    return true;
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
    leaseId: string,
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
}
