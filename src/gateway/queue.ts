/**
 * The fleet's one FIFO (ADR 0005 §10/§11): a thin composition over `src/leasing/wait-queue.ts`'s
 * `WaitQueue`, not a fork of it. `WaitQueue` already owns exactly the state a fleet queue needs
 * -- FIFO membership, per-request timeout/cancellation, and settlement promises -- and its
 * `LeaseRequestOptions` (`requesterId`, `ownerId`, `timeoutMs`, `noWait`, `allowDownload`,
 * `onProgress`, `ttlMs`) are already the fields a fleet request carries. This module only
 * narrows `WaitQueue`'s generic `Waiter`/`LeaseGrant` shapes to what the fleet actually produces
 * (a `DeviceRequest` for the request, and a lease record that may additionally carry `worker`
 * once it names a machine) and forwards every method through.
 *
 * `WaitQueue` and its types come from `../leasing/index.js`. `DeviceRequest`/`DeviceRecord`/
 * `LeaseRecord`/`WaiterState` are `wait-queue.js`'s own transitive type imports
 * (`core/domain.js`, `core/driver.js`) -- on core's index, and
 * allowed to the gateway by name in `.oxlintrc.json` -- not a reach into the registry, capacity, or lifecycle engine ADR 0005
 * §33 keeps off limits.
 */
import type { Clock, IdGenerator } from "../ports/index.js";
import { type LeaseRecord, type DeviceRequest, type LeaseProgress } from "../core/index.js";
import {
  WaitQueue,
  type LeaseRequestOptions,
  type QueuePlace,
  type WaiterState,
} from "../leasing/index.js";

export type { LeaseProgress } from "../core/index.js";
export type { LeaseRequestOptions } from "../leasing/index.js";
export { RequestCancelledError, RequesterAlreadyLeasedError } from "../leasing/index.js";

/**
 * The lease record a fleet grant carries. Identical to a worker's own `LeaseRecord` plus the
 * additive `worker` (ADR 0005 §18) `FleetLeaseCoordinator` stamps once it knows which machine
 * granted it -- absent on nothing this queue itself ever produces (it never grants; the
 * coordinator does), so the type says `?` rather than the coordinator having to fabricate one.
 */
export type FleetLeaseRecord = LeaseRecord & {
  readonly worker?: { readonly id: string; readonly label?: string };
};

/**
 * A fleet grant: the worker's own device/environment/timing, forwarded verbatim (the gateway
 * never interprets either -- it is not the driver that produced them), plus the lease record
 * above. Untyped (`unknown`) on `device`/`timing` for the same reason: this module has no
 * business knowing their shape, only relaying it.
 */
export interface FleetLeaseGrant {
  readonly device: unknown;
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: FleetLeaseRecord;
  readonly timing: unknown;
}

export interface FleetWaiter {
  readonly id: string;
  readonly request: DeviceRequest;
  readonly options: LeaseRequestOptions;
  readonly promise: Promise<FleetLeaseGrant>;
  readonly state: WaiterState;
}

export interface FleetQueueOptions {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  /** Reports the timeout only; it does not wake the dispatch loop for the waiters behind. */
  readonly onTimeout?: (waiter: FleetWaiter) => void;
  readonly onDepthChange?: ((depth: number, line: "virtual" | "physical") => void) | undefined;
}

/** `WaitQueue` has no fleet awareness; every waiter reaching here was minted by this queue, so the cast holds. */
function asFleet<Value>(value: Value): Value extends undefined ? undefined : FleetWaiter {
  return value as never;
}

export class FleetQueue {
  readonly #queue: WaitQueue;

  constructor(options: FleetQueueOptions) {
    this.#queue = new WaitQueue({
      clock: options.clock,
      idGenerator: options.idGenerator,
      onDepthChange: options.onDepthChange,
      ...(options.onTimeout === undefined
        ? {}
        : { onTimeout: (waiter) => options.onTimeout?.(asFleet(waiter)) }),
    });
  }

  get depth(): number {
    return this.#queue.depth;
  }

  get physicalDepth(): number {
    return this.#queue.physicalDepth;
  }

  list(): readonly FleetWaiter[] {
    return this.#queue.list().map((waiter) => asFleet(waiter));
  }

  places(): readonly QueuePlace[] {
    return this.#queue.places();
  }

  hasPendingRequester(requesterId: string): boolean {
    return this.#queue.hasPendingRequester(requesterId);
  }

  findPendingWaiter(requesterId: string): FleetWaiter | undefined {
    return asFleet(this.#queue.findPendingWaiter(requesterId));
  }

  create(request: DeviceRequest, options: LeaseRequestOptions, id?: string): FleetWaiter {
    return asFleet(this.#queue.create(request, options, id));
  }

  enqueue(waiter: FleetWaiter): boolean {
    return this.#queue.enqueue(waiter as never);
  }

  markProcessing(waiter: FleetWaiter): boolean {
    return this.#queue.markProcessing(waiter as never);
  }

  isQueued(waiter: FleetWaiter): boolean {
    return this.#queue.isQueued(waiter as never);
  }

  notifyProgress(waiter: FleetWaiter, progress: LeaseProgress): void {
    this.#queue.notifyProgress(waiter as never, progress);
  }

  resolve(waiter: FleetWaiter, grant: FleetLeaseGrant): boolean {
    return this.#queue.resolve(waiter as never, grant as never);
  }

  reject(waiter: FleetWaiter, error: Error): boolean {
    return this.#queue.reject(waiter as never, error);
  }

  cancelAll(error: Error | ((waiter: FleetWaiter) => Error)): readonly FleetWaiter[] {
    if (typeof error === "function") {
      return this.#queue
        .cancelAll((waiter) => error(asFleet(waiter)))
        .map((waiter) => asFleet(waiter));
    }
    return this.#queue.cancelAll(error).map((waiter) => asFleet(waiter));
  }
}
