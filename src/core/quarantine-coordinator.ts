import type { EventBus } from "../bus/index.js";
import { type Clock, type Logger, NoopLogger, type TimerHandle } from "../ports/index.js";
import type { DeviceOperationClaim, DeviceOperationClaims } from "./device-operation-claims.js";
import { type DeviceRecord, mayBeGranted, type Platform, type VirtualDevice } from "./domain.js";
import { type Driver, toDriverDevice } from "./driver.js";
import type { SerializedDecision } from "./serialized-decision.js";
import { stableError } from "./stable-error.js";

export interface QuarantineDriverCatalog {
  get(platform: Platform): Driver;
}

export interface QuarantineRegistry {
  readonly snapshot: { readonly devices: readonly DeviceRecord[] };
  enterQuarantine(deviceId: string, nextRetryAt: number): Promise<DeviceRecord>;
  recordQuarantineRetryFailure(
    deviceId: string,
    attempts: number,
    nextRetryAt: number,
  ): Promise<DeviceRecord>;
  recoverFromQuarantine(deviceId: string, to: "ready" | "shutdown"): Promise<DeviceRecord>;
  strandQuarantine(deviceId: string, attempts: number): Promise<DeviceRecord>;
  deleteQuarantined(deviceId: string, initiator: string): Promise<DeviceRecord>;
}

export interface QuarantinePurgeFailure {
  readonly deviceId: string;
  readonly leaseId: string;
  readonly attemptedStrategy: "erase" | "snapshot" | "wipe" | "delete" | "uninstall";
  readonly duration: number;
  readonly error: string;
}

export interface QuarantineRetryConfig {
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly retryBackoffMultiplier: number;
  readonly maxRetryBackoffMs: number;
}

export interface QuarantineCoordinatorOptions {
  readonly claims: Pick<DeviceOperationClaims, "tryClaim">;
  readonly clock: Clock;
  readonly config: QuarantineRetryConfig;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: QuarantineDriverCatalog;
  readonly eventBus: Pick<EventBus, "emit">;
  readonly notifyAvailability: () => void;
  readonly registry: QuarantineRegistry;
  readonly logger?: Logger;
}

export class QuarantineCoordinator {
  readonly #timers = new Map<string, TimerHandle>();
  #disposed = false;
  readonly #logger: Logger;

  constructor(private readonly options: QuarantineCoordinatorOptions) {
    this.#logger = options.logger?.child("quarantine-coordinator") ?? new NoopLogger();
  }

  /**
   * Commits quarantine entry for a device whose release-time purge just
   * failed, emits the (unchanged) `device.purge-failed` fact alongside the
   * new `device.quarantined` fact, and arms the first retry. Capacity
   * accounting does not change here -- a virtual device in `reclaiming` and `quarantined` both
   * counts as running -- so no queued waiter can be satisfied by this alone
   * and `notifyAvailability` is not called.
   */
  // fallow-ignore-next-line unused-class-member -- called through ReclaimCoordinator's quarantine port.
  async enter(failure: QuarantinePurgeFailure): Promise<void> {
    const nextRetryAt = this.options.clock.now() + this.options.config.retryBackoffMs;
    await this.options.decisions.run(async () => {
      await this.options.registry.enterQuarantine(failure.deviceId, nextRetryAt);
      this.options.eventBus.emit(
        "device.purge-failed",
        {
          attemptedStrategy: failure.attemptedStrategy,
          deviceId: failure.deviceId,
          duration: failure.duration,
          error: failure.error,
          leaseId: failure.leaseId,
        },
        "quarantine-coordinator",
      );
      this.options.eventBus.emit(
        "device.quarantined",
        { deviceId: failure.deviceId, maxRetries: this.options.config.maxRetries, nextRetryAt },
        "quarantine-coordinator",
      );
    });
    this.#arm(failure.deviceId, nextRetryAt);
  }

  /**
   * Commits quarantine entry for a device Doctor found stuck mid-transition past its
   * driver-derived stall threshold (`provisioning -> quarantined`; see domain.ts and
   * doctor.ts). Distinct from `enter()`: there is no purge failure, no lease, and no
   * `attemptedStrategy` to report, so only `device.quarantined` fires here --
   * `device.purge-failed` stays specific to the release-time path. Retry/give-up
   * thereafter is identical: `#retry` treats every quarantined device the same regardless of
   * how it arrived.
   */
  async enterFromStalledTransition(deviceId: string): Promise<void> {
    const nextRetryAt = this.options.clock.now() + this.options.config.retryBackoffMs;
    await this.options.decisions.run(async () => {
      await this.options.registry.enterQuarantine(deviceId, nextRetryAt);
      this.options.eventBus.emit(
        "device.quarantined",
        { deviceId, maxRetries: this.options.config.maxRetries, nextRetryAt },
        "quarantine-coordinator",
      );
    });
    this.#arm(deviceId, nextRetryAt);
  }

  /**
   * Re-arms retry timers for devices still `quarantined` after a daemon
   * restart, using the persisted `quarantineNextRetryAt` (a retry already due
   * fires immediately, same as `LeaseExpiryScheduler.restore`). `include` leaves out the devices
   * a daemon start must not act on: a retry that is due drives the driver at once, and startup
   * does not drive a platform it could not read (ADR 0019 §1 step 5).
   */
  restore(include: (device: DeviceRecord) => boolean = () => true): void {
    for (const device of this.options.registry.snapshot.devices) {
      if (device.state !== "quarantined" || !include(device)) continue;
      this.#arm(device.id, device.quarantineNextRetryAt ?? this.options.clock.now());
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers.values()) this.options.clock.cancel(timer);
    this.#timers.clear();
  }

  #arm(deviceId: string, nextRetryAt: number): void {
    if (this.#disposed) return;
    const existing = this.#timers.get(deviceId);
    if (existing !== undefined) this.options.clock.cancel(existing);
    const delay = Math.max(0, nextRetryAt - this.options.clock.now());
    this.#timers.set(
      deviceId,
      this.options.clock.setTimer(delay, () => {
        this.#timers.delete(deviceId);
        void this.#retry(deviceId).catch((error: unknown) => {
          this.#logger.error("quarantine retry threw", {
            deviceId,
            step: "retry",
            error: stableError(error),
          });
        });
      }),
    );
  }

  async #retry(deviceId: string): Promise<void> {
    if (this.#disposed) return;
    // A device leaves `quarantined` only through this coordinator (recovered or
    // abandoned), so a re-read that finds it gone or moved on means a stale
    // timer fired after the fact -- nothing to do.
    const device = await this.options.decisions.run(() =>
      this.options.registry.snapshot.devices.find(
        (candidate) => candidate.id === deviceId && candidate.state === "quarantined",
      ),
    );
    if (device === undefined) return;

    const claim = this.options.claims.tryClaim(deviceId, "reclaim");
    if (claim === undefined) {
      this.#arm(deviceId, this.options.clock.now() + this.options.config.retryBackoffMs);
      return;
    }
    try {
      await this.#retryClaimed(device, claim);
    } finally {
      claim.release();
    }
  }

  /**
   * Every exit releases the claim right after the last write, before the coordinator's own facts
   * and the wake-up that follow it: the planner never grants a claimed device, so a wake-up under
   * the claim would pass over the device it was sent for.
   */
  async #retryClaimed(device: DeviceRecord, claim: DeviceOperationClaim): Promise<void> {
    const attempts = (device.quarantineAttempts ?? 0) + 1;
    const driver = this.options.drivers.get(device.spec.platform);
    if (!device.physical && !mayBeGranted(device)) {
      await this.#retryDelete(driver, device, attempts, claim);
      return;
    }
    let result: Awaited<ReturnType<Driver["reclaim"]>>;
    try {
      result = await driver.reclaim(toDriverDevice(device), { clean: "standard" });
    } catch (error: unknown) {
      this.#logRetryFailure("quarantine reclaim retry failed", device, "reclaim", attempts, error);
      await this.#retryFailed(device, attempts, claim);
      return;
    }

    await this.options.decisions.run(() =>
      this.options.registry.recoverFromQuarantine(device.id, result.state),
    );
    claim.release();
    this.options.eventBus.emit(
      "device.quarantine-recovered",
      {
        attempts,
        deviceId: device.id,
        strategy: result.strategy,
        ...(result.missingApps === undefined ? {} : { missingApps: result.missingApps }),
      },
      "quarantine-coordinator",
    );
    this.options.notifyAvailability();
  }

  /**
   * A spent fresh device already served its one lease, so a successful reclaim would put it
   * back in the pool for a second one. It retries the delete instead, and success is
   * `device.deleted`, not `device.quarantine-recovered`: nothing rejoined the pool.
   */
  async #retryDelete(
    driver: Driver,
    device: VirtualDevice,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    try {
      await driver.destroy(toDriverDevice(device));
    } catch (error: unknown) {
      this.#logRetryFailure("quarantine delete retry failed", device, "delete", attempts, error);
      await this.#retryFailed(device, attempts, claim);
      return;
    }
    await this.options.decisions.run(() =>
      this.options.registry.deleteQuarantined(device.id, "lease-end"),
    );
    claim.release();
    this.options.notifyAvailability();
  }

  #logRetryFailure(
    message: string,
    device: DeviceRecord,
    step: string,
    attempts: number,
    error: unknown,
  ): void {
    this.#logger.warn(message, { deviceId: device.id, step, attempts, error: stableError(error) });
  }

  async #retryFailed(
    device: DeviceRecord,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    if (attempts >= this.options.config.maxRetries) {
      await this.#giveUp(device, attempts, claim);
      return;
    }
    const nextRetryAt = this.options.clock.now() + backoffDelay(this.options.config, attempts);
    await this.options.decisions.run(() =>
      this.options.registry.recordQuarantineRetryFailure(device.id, attempts, nextRetryAt),
    );
    this.#arm(device.id, nextRetryAt);
  }

  async #giveUp(
    device: DeviceRecord,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    if (device.physical) {
      await this.#unenroll(device, attempts, claim);
      return;
    }
    const driver = this.options.drivers.get(device.spec.platform);
    try {
      await driver.destroy(toDriverDevice(device));
    } catch (error: unknown) {
      // Destroy itself failed: leave the device quarantined -- still uncounted
      // against a grant, still counted against capacity -- rather than either
      // reusing a dirty device or losing track of one that never got cleaned
      // up. No further retry is scheduled, so this is a terminal state that
      // only an operator (`simlock doctor` / `nuke`) leaves; emit it as its own
      // fact rather than letting a device strand itself in silence.
      await this.options.decisions.run(() =>
        this.options.registry.strandQuarantine(device.id, attempts),
      );
      claim.release();
      this.options.eventBus.emit(
        "device.quarantine-stranded",
        { attempts, deviceId: device.id, error: stableError(error) },
        "quarantine-coordinator",
      );
      return;
    }
    await this.options.decisions.run(() =>
      this.options.registry.deleteQuarantined(device.id, "quarantine-coordinator"),
    );
    this.#abandoned(device, attempts, claim);
  }

  /**
   * A physical device is the owner's, so running out of retries unenrols it and never destroys it
   * (safety rule 2); `device.quarantine-stranded` cannot happen to it, as nothing here can fail.
   */
  async #unenroll(
    device: DeviceRecord,
    attempts: number,
    claim: DeviceOperationClaim,
  ): Promise<void> {
    await this.options.decisions.run(() =>
      this.options.registry.deleteQuarantined(device.id, "quarantine"),
    );
    this.#abandoned(device, attempts, claim);
  }

  #abandoned(device: DeviceRecord, attempts: number, claim: DeviceOperationClaim): void {
    claim.release();
    this.options.eventBus.emit(
      "device.quarantine-abandoned",
      { attempts, deviceId: device.id },
      "quarantine-coordinator",
    );
    this.options.notifyAvailability();
  }
}

function backoffDelay(config: QuarantineRetryConfig, attemptsSoFar: number): number {
  return Math.min(
    config.retryBackoffMs * config.retryBackoffMultiplier ** attemptsSoFar,
    config.maxRetryBackoffMs,
  );
}
