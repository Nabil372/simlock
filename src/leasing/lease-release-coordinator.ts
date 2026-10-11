import { type Logger, NoopLogger } from "../ports/index.js";
import {
  type AbsentReason,
  type DeviceOperationClaims,
  type LeaseRecord,
  type ReleasedLease,
  type SerializedDecision,
  type ReclaimCoordinator,
} from "../core/index.js";

export type LeaseReleaseReason = "explicit" | "killed" | "device-lost";

export interface LeaseReleaseCommands {
  release(leaseId: string, reason: LeaseReleaseReason): Promise<void>;
  releaseAll(reason: Exclude<LeaseReleaseReason, "device-lost">): Promise<readonly string[]>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
}

export interface LeaseExpirationAdmin {
  expire(leaseId: string, expectedDeadline?: number): Promise<void>;
}

export interface LeaseReleaseMaintenance {
  beginMaintenance(): Promise<void>;
  releaseAllDuringMaintenance(reason: "killed"): Promise<readonly string[]>;
  endMaintenance(): Promise<void>;
}

export type StartupDeviceOutcome = "reclaim" | "wait" | "missing";

export interface StartupEnding {
  readonly device: StartupDeviceOutcome;
  readonly reason: "device-lost" | "expired";
}

export interface StartupLeaseEnder {
  endAtStartup(leaseId: string, ending: StartupEnding): Promise<void>;
}

export interface LeaseReleaseLifecycle {
  beginRelease(
    leaseId: string,
    reason: LeaseReleaseReason | "expired",
    options?: { readonly deferReclaim?: boolean },
  ): Promise<ReleasedLease>;
  endForMissingDevice(leaseId: string, reason: "expired" | "device-lost"): Promise<ReleasedLease>;
  endForAbsentDevice(leaseId: string, absentReason: AbsentReason): Promise<ReleasedLease>;
  renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord>;
}

export interface LeaseReleaseRegistry {
  readonly snapshot: { readonly leases: readonly LeaseRecord[] };
}

export interface LeaseReleaseCoordinatorOptions {
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly lifecycle: LeaseReleaseLifecycle;
  readonly logger?: Logger;
  readonly notifyAvailability: () => void;
  readonly registry: LeaseReleaseRegistry;
  readonly reclaim: Pick<ReclaimCoordinator, "reclaim" | "reclaimReturned">;
}

type ReclaimMode = "await" | "background" | "none";

/**
 * Lease commits happen in the serialized decision section; reclaiming is deliberately outside it.
 * Concurrent `releaseAll` calls are not idempotent: overlapping snapshots can yield UnknownLeaseError.
 */
export class LeaseReleaseCoordinator
  implements LeaseReleaseCommands, LeaseExpirationAdmin, LeaseReleaseMaintenance, StartupLeaseEnder
{
  readonly #activeWorkflows = new Set<Promise<void>>();
  readonly #backgroundReclaims = new Set<Promise<void>>();
  readonly #logger: Logger;
  readonly #maintenanceWaiters: (() => void)[] = [];
  #maintenanceDepth = 0;

  constructor(private readonly options: LeaseReleaseCoordinatorOptions) {
    this.#logger = options.logger?.child("lease-release-coordinator") ?? new NoopLogger();
  }

  async release(leaseId: string, reason: LeaseReleaseReason): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, reason, { reclaim: "background" }));
  }

  async releaseAll(reason: "explicit" | "killed"): Promise<readonly string[]> {
    return this.#runNormal(() => this.#releaseAll(reason, "background"));
  }

  /**
   * Gives up a lease whose device could not be brought back. Internally
   * originated only -- no client can ask for it -- but it is an ordinary
   * release otherwise, so it takes the same maintenance admission and the same
   * reclaim as every other one.
   */
  async releaseDeviceLost(leaseId: string): Promise<void> {
    await this.#runNormal(() => this.#release(leaseId, "device-lost", { reclaim: "background" }));
  }

  async expire(leaseId: string, expectedDeadline?: number): Promise<void> {
    await this.#runNormal(() =>
      this.#release(leaseId, "expired", {
        ...(expectedDeadline === undefined ? {} : { expectedDeadline }),
        reclaim: "background",
      }),
    );
  }

  /**
   * Ends a lease at daemon start, because its device is not running. An ordinary release in every
   * way but the device: `reclaim` starts the usual background reclaim, `wait` starts none and
   * takes no claim (a driver that just failed or hung on its listing would likely hang the
   * reclaim too, and a hung reclaim holds its claim with no end), and `missing` removes the lease
   * and marks the device missing in one write, with nothing to wipe.
   */
  async endAtStartup(leaseId: string, ending: StartupEnding): Promise<void> {
    await this.#runNormal(async () => {
      switch (ending.device) {
        case "missing":
          await this.options.decisions.run(() =>
            this.options.lifecycle.endForMissingDevice(leaseId, ending.reason),
          );
          return;
        case "reclaim":
          await this.#release(leaseId, ending.reason, { reclaim: "background" });
          return;
        case "wait":
          await this.#release(leaseId, ending.reason, { reclaim: "none" });
          return;
        default:
          throw new Error(`Unknown startup ending for ${leaseId}: ${String(ending.device)}`);
      }
    });
  }

  /** A lease already gone is not an error: the release that took it came first. */
  // fallow-ignore-next-line unused-class-member -- called through PhysicalDeviceWatcher's releaser port.
  async endForAbsentDevice(
    leaseId: string,
    absentReason: AbsentReason,
    proceed: () => boolean = () => true,
  ): Promise<boolean> {
    return this.#runNormal(() =>
      this.options.decisions.run(async () => {
        if (
          !proceed() ||
          !this.options.registry.snapshot.leases.some((lease) => lease.id === leaseId)
        ) {
          return false;
        }
        await this.options.lifecycle.endForAbsentDevice(leaseId, absentReason);
        return true;
      }),
    );
  }

  /** Under the maintenance admission every release takes, so no watcher write lands while an operator reset walks the devices. */
  // fallow-ignore-next-line unused-class-member -- called through PhysicalDeviceWatcher's releaser port.
  async admit<Result>(work: () => Promise<Result>): Promise<Result> {
    return this.#runNormal(work);
  }

  /** The reclaim joins the background reclaims, so nuke's `beginMaintenance` and a graceful stop wait for it. */
  // fallow-ignore-next-line unused-class-member -- called through PhysicalDeviceWatcher's releaser port.
  async reclaimReturned(
    deviceId: string,
    osVersion?: string,
    proceed: () => boolean = () => true,
  ): Promise<boolean> {
    return this.#runNormal(async () => {
      const started = await this.options.reclaim.reclaimReturned(deviceId, osVersion, proceed);
      if (started === undefined) return false;
      const tracked = started.settled.then(() => undefined);
      this.#backgroundReclaims.add(tracked);
      void tracked.finally(() => this.#backgroundReclaims.delete(tracked));
      return true;
    });
  }

  async settleBackgroundReclaims(): Promise<void> {
    while (this.#backgroundReclaims.size > 0) {
      await Promise.allSettled(this.#backgroundReclaims);
    }
  }

  async renew(leaseId: string, ttlMs?: number): Promise<LeaseRecord> {
    return this.#runNormal(() =>
      this.options.decisions.run(() => this.options.lifecycle.renew(leaseId, ttlMs)),
    );
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async beginMaintenance(): Promise<void> {
    await this.options.decisions.run(() => {
      this.#maintenanceDepth += 1;
    });
    // Backgrounded reclaims are drained alongside the workflows that started them:
    // a device still `reclaiming` is neither `ready` nor `shutdown`, so an operator
    // reset would silently skip it (`NukeService#canOperate`) and leave a device
    // running that the reset was supposed to take down.
    while (this.#activeWorkflows.size > 0 || this.#backgroundReclaims.size > 0) {
      await Promise.allSettled([...this.#activeWorkflows, ...this.#backgroundReclaims]);
    }
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async releaseAllDuringMaintenance(reason: "killed"): Promise<readonly string[]> {
    await this.options.decisions.run(() => {
      if (this.#maintenanceDepth === 0) {
        throw new Error("Maintenance-authorized release requires active maintenance");
      }
    });
    // Awaited rather than backgrounded: the reset walks the device list straight
    // afterwards and only acts on `ready`/`shutdown` records, so a reclaim still in
    // flight would take its device out of that walk entirely.
    return this.#releaseAll(reason, "await");
  }

  // fallow-ignore-next-line unused-class-member -- called through LeaseMaintenance by NukeService.
  async endMaintenance(): Promise<void> {
    const waiters = await this.options.decisions.run(() => {
      this.#maintenanceDepth = Math.max(0, this.#maintenanceDepth - 1);
      return this.#maintenanceDepth === 0 ? this.#maintenanceWaiters.splice(0) : [];
    });
    for (const wake of waiters) wake();
  }

  async #release(
    leaseId: string,
    reason: LeaseReleaseReason | "expired",
    options: { readonly expectedDeadline?: number; readonly reclaim: ReclaimMode },
  ): Promise<void> {
    const { expectedDeadline } = options;
    const released = await this.options.decisions.run(() => {
      if (expectedDeadline !== undefined) {
        const current = this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId);
        if (current?.ttlDeadline !== expectedDeadline) return undefined;
      }
      // `none` is a wipe put off, not one given up: the device records it, so a later start
      // that can read its platform runs the full reclaim (ADR 0019 §2).
      return this.options.lifecycle.beginRelease(
        leaseId,
        reason,
        options.reclaim === "none" ? { deferReclaim: true } : {},
      );
    });
    if (released === undefined || options.reclaim === "none") return;
    if (options.reclaim === "background") {
      // The registry-only half committed above is the whole of what a releasing
      // caller needs: the lease record is gone, `lease.released` has been emitted,
      // and the device is `reclaiming` and therefore already ungrantable
      // (AcquisitionPlanner only ever selects `ready`). The slow part -- the
      // driver-side purge, where an iOS erase runs tens of seconds -- carries no
      // information the caller can act on, so it proceeds in the background and the
      // caller gets its turn back immediately. That matters most for an agent
      // releasing through MCP or the CLI, which would otherwise sit on a tool call
      // waiting for a device it has already given up, and for an operator's
      // `release --all` or `nuke`, where N leases would otherwise cost N serial
      // erases before the command answers (#43). Startup is the third such caller, for a
      // lease it ends because its device is not running (`endAtStartup`, ADR 0019).
      //
      // Kicked off here rather than queued, so every device's reclaim starts
      // immediately (not one-after-another): queuing would let a healthy reclaim sit
      // idle in `reclaiming` waiting its turn, which is exactly the state age a
      // stalled-transition detector would misread as a stall.
      this.#reclaimInBackground(released);
      return;
    }
    await this.options.reclaim.reclaim(released);
  }

  /** The claim lasts as long as the reclaim, so startup recovery and doctor's stalled-transition check take a live reclaim for neither orphaned nor stalled. */
  #reclaimInBackground(released: ReleasedLease): void {
    const claim = this.options.claims.tryClaim(released.device.id, "reclaim");
    const reclaim = this.options.reclaim
      .reclaim(released)
      .catch((error: unknown) => {
        this.#logger.error("background reclaim failed", {
          deviceId: released.device.id,
          error: error instanceof Error ? error.message : String(error),
          leaseId: released.lease.id,
        });
      })
      .finally(() => {
        claim?.release();
        // `ReclaimCoordinator` already wakes the queue on every path that frees a
        // device, and it does so before this claim is released, so the wake-up here is a
        // safety net, not the one that serves a waiter: it runs after the claim is gone,
        // so matching sees the device even if an earlier wake-up raced the release.
        this.options.notifyAvailability();
      });
    this.#backgroundReclaims.add(reclaim);
    void reclaim.finally(() => this.#backgroundReclaims.delete(reclaim));
  }

  async #releaseAll(
    reason: "explicit" | "killed",
    reclaim: ReclaimMode,
  ): Promise<readonly string[]> {
    const leaseIds = this.options.registry.snapshot.leases.map((lease) => lease.id);
    await Promise.all(leaseIds.map(async (leaseId) => this.#release(leaseId, reason, { reclaim })));
    return leaseIds;
  }

  async #runNormal<Result>(workflow: () => Promise<Result>): Promise<Result> {
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    await this.#awaitAdmission(completion);

    try {
      return await workflow();
    } finally {
      complete();
      this.#activeWorkflows.delete(completion);
    }
  }

  async #awaitAdmission(completion: Promise<void>): Promise<void> {
    for (;;) {
      let waitForOpen: Promise<void> | undefined;
      const admitted = await this.options.decisions.run(() => {
        if (this.#maintenanceDepth === 0) {
          this.#activeWorkflows.add(completion);
          return true;
        }
        waitForOpen = new Promise<void>((resolve) => this.#maintenanceWaiters.push(resolve));
        return false;
      });
      if (admitted) return;
      await waitForOpen;
    }
  }
}
