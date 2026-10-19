import type { EventEnvelope } from "../../../bus/index.js";
import type { SqliteDatabase } from "../../../ports/index.js";
import type { HistoryProjectionOptions, ProjectionHandle } from "../../index.js";
import { Ledger } from "./ledger.js";
import { MinuteRecorder } from "./minutes.js";
import { recreateTable, tableMatches, USAGE_TABLES } from "./schema.js";
import { Statements } from "./statements.js";
import { minuteOf, type UsageValue } from "./types.js";
import { amount, END_REASONS, oneOf, payloadOf, SOURCES, specOf, text } from "./wire.js";

interface Origin {
  readonly relayed: boolean;
  readonly worker: string;
}

const OWN: Origin = { relayed: false, worker: "" };

const DEVICE_FACTS: Readonly<Record<string, string | undefined>> = {
  "device.provisioned": "duration",
  "device.quarantine-abandoned": undefined,
  "device.quarantine-recovered": undefined,
  "device.quarantine-stranded": undefined,
  "device.quarantined": undefined,
  "device.ready": "bootDuration",
  "device.recovered": "duration",
  "device.recovery-failed": undefined,
};

class Projector implements ProjectionHandle {
  readonly #database: SqliteDatabase;
  readonly #options: HistoryProjectionOptions;
  readonly #statements: Statements;
  readonly #ledger: Ledger;
  readonly #minutes: MinuteRecorder;
  #waiting = new Map<string, number>();
  #held = new Map<string, Map<string, number>>();
  #loaded = false;
  readonly #queues = new Map<string, { plain: number; physical: number }>();
  readonly #levels = new Map<string, Map<string, Map<UsageValue, number>>>();
  readonly #connected = new Set<string>();

  constructor(database: SqliteDatabase, options: HistoryProjectionOptions) {
    this.#database = database;
    this.#options = options;
    this.#statements = new Statements(database);
    this.#ledger = new Ledger(this.#statements);
    this.#minutes = new MinuteRecorder(this.#statements);
  }

  apply(envelope: EventEnvelope): void {
    const at = amount(envelope.timestamp);
    if (at === undefined) return;
    const payload = payloadOf(envelope.payload);
    if (envelope.event === "worker.disconnected") {
      if (this.#options.fleet) this.#disconnected(payload, at);
      return;
    }
    const origin = this.#originOf(payload);
    if (origin === undefined) return;
    this.#load();
    if (Object.hasOwn(DEVICE_FACTS, envelope.event)) {
      this.#deviceFact(envelope.event, payload, origin, at);
      return;
    }
    switch (envelope.event) {
      case "lease.requested":
        if (!origin.relayed) this.#requested(payload, at);
        return;
      case "lease.rejected":
        if (!origin.relayed) this.#rejected(payload, at);
        return;
      case "lease.declined":
        this.#declined(payload, origin, at);
        return;
      case "request.granted":
        if (!origin.relayed) this.#dispatched(payload, at);
        return;
      case "lease.granted":
        if (origin.relayed || !this.#options.fleet) this.#granted(payload, origin, at);
        return;
      case "lease.released":
      case "lease.expired":
        if (origin.relayed || !this.#options.fleet)
          this.#ended(envelope.event, payload, origin, at);
        return;
      case "capacity.changed":
        this.#capacity(payload, origin, at);
        return;
      case "queue.changed":
        this.#queue(payload, origin, at);
        return;
      case "daemon.stopping":
        if (!origin.relayed) this.#stopping(at);
        return;
      case "daemon.started":
        if (!origin.relayed) this.#started(at);
        return;
      default:
        return;
    }
  }

  prune(now: number): void {
    const cutoff = now - this.#options.metricsRetentionMs;
    for (const [table, column] of [
      ["request_rows", "requestedAt"],
      ["minute_rows", "minute"],
      ["gaps", "at"],
      ["device_fact_rows", "at"],
      ["held_leases", "at"],
    ] as const) {
      this.#statements.get(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
    }
    this.#loaded = false;
  }

  rebuild(oldestEventAt: number | undefined): void {
    for (const table of USAGE_TABLES) {
      if (!tableMatches(this.#database, table)) recreateTable(this.#database, table);
    }
    this.#statements.clear();
    if (oldestEventAt !== undefined) {
      const minute = minuteOf(oldestEventAt);
      for (const [table, column, from] of [
        ["request_rows", "requestedAt", oldestEventAt],
        ["minute_rows", "minute", minute],
        ["gaps", "at", minute],
        ["device_fact_rows", "at", oldestEventAt],
        ["held_leases", "at", oldestEventAt],
      ] as const) {
        this.#statements.get(`DELETE FROM ${table} WHERE ${column} >= ?`).run(from);
      }
    }
    this.#minutes.closeOpenRows();
    this.#minutes.forget();
    this.#levels.clear();
    this.#connected.clear();
    this.#queues.clear();
    this.#loaded = false;
  }

  #load(): void {
    if (this.#loaded) return;
    this.#waiting = this.#ledger.waitingByPlatform();
    this.#held = this.#ledger.heldByWorker();
    this.#loaded = true;
  }

  #originOf(payload: Readonly<Record<string, unknown>>): Origin | undefined {
    if (!this.#options.fleet || payload.workerId === undefined) return OWN;
    const worker = text(payload.workerId);
    return worker === undefined ? undefined : { relayed: true, worker };
  }

  #requested(payload: Readonly<Record<string, unknown>>, at: number): void {
    const requestId = text(payload.requestId);
    if (requestId === undefined) return;
    const spec = specOf(payload.requestSpec);
    const probe = text(payload.fleetRequestId) !== undefined;
    const platform = spec.platform ?? "";
    const inserted = this.#ledger.insertRequest({
      at,
      model: spec.model,
      platform,
      probe,
      requestId,
      requester: text(payload.requester) ?? "",
    });
    if (inserted && !probe) this.#bump(this.#waiting, platform, 1, "waiting", OWN, at);
  }

  #rejected(payload: Readonly<Record<string, unknown>>, at: number): void {
    const requestId = text(payload.requestId);
    if (requestId === undefined) return;
    const reason = text(payload.reason) ?? null;
    const workerId = reason === "worker-failed" ? (text(payload.worker) ?? null) : null;
    if (!this.#ledger.exists(requestId)) {
      const spec = specOf(payload.requestSpec);
      this.#ledger.insertRefusal(
        {
          at,
          model: spec.model,
          platform: spec.platform ?? "",
          requestId,
          requester: text(payload.requester) ?? "",
        },
        { reason, workerId },
      );
      return;
    }
    this.#settle(
      requestId,
      () => this.#ledger.reject(requestId, { at, declined: false, reason, workerId }),
      at,
    );
  }

  #declined(payload: Readonly<Record<string, unknown>>, origin: Origin, at: number): void {
    const requestId = text(payload.requestId);
    if (requestId === undefined) return;
    if (!origin.relayed) {
      this.#settle(
        requestId,
        () =>
          this.#ledger.reject(requestId, {
            at,
            declined: true,
            reason: text(payload.reason) ?? null,
            workerId: null,
          }),
        at,
      );
    }
    this.#fact({
      at,
      deviceId: undefined,
      durationMs: undefined,
      kind: "lease.declined",
      platform: specOf(payload.requestSpec).platform,
      workerId: origin.relayed ? origin.worker : undefined,
    });
  }

  #dispatched(payload: Readonly<Record<string, unknown>>, at: number): void {
    const requestId = text(payload.requestId);
    if (requestId === undefined) return;
    this.#settle(
      requestId,
      () =>
        this.#ledger.grantDispatched(requestId, {
          at,
          leaseId: text(payload.leaseId) ?? null,
          workerId: text(payload.worker) ?? null,
          workerLeaseId: text(payload.workerLeaseId) ?? null,
        }),
      at,
    );
  }

  #settle(requestId: string, outcome: () => void, at: number): void {
    const open = this.#ledger.findOpen(requestId);
    if (open === undefined) return;
    outcome();
    if (!open.probe) this.#bump(this.#waiting, open.platform, -1, "waiting", OWN, at);
  }

  #granted(payload: Readonly<Record<string, unknown>>, origin: Origin, at: number): void {
    const leaseId = text(payload.leaseId);
    if (leaseId === undefined) return;
    const requestId = text(payload.requestId);
    const source = oneOf(payload.source, SOURCES) ?? null;
    const platform =
      text(payload.platform) ??
      (requestId === undefined || origin.relayed
        ? undefined
        : this.#ledger.requestPlatform(requestId)) ??
      "";
    this.#touch(origin, at);
    if (this.#ledger.holdLease(origin.worker, { at, leaseId, platform, source })) {
      this.#bump(this.#heldOf(origin.worker), platform, 1, "leasesHeld", origin, at);
    }
    if (origin.relayed) {
      if (source !== null) this.#ledger.attachSource(origin.worker, leaseId, source);
    } else if (requestId !== undefined) {
      this.#settle(requestId, () => this.#ledger.grant(requestId, { at, leaseId, source }), at);
    }
  }

  #ended(
    event: string,
    payload: Readonly<Record<string, unknown>>,
    origin: Origin,
    at: number,
  ): void {
    const leaseId = text(payload.leaseId);
    if (leaseId === undefined) return;
    const endReason =
      event === "lease.expired" ? "expired" : (oneOf(payload.reason, END_REASONS) ?? null);
    this.#touch(origin, at);
    const held = this.#ledger.releaseLease(origin.worker, leaseId);
    if (held !== undefined) {
      this.#bump(this.#heldOf(origin.worker), held.platform, -1, "leasesHeld", origin, at);
    }
    if (origin.relayed) {
      this.#ledger.endByWorkerLease(origin.worker, leaseId, {
        at,
        endReason,
        heldFrom: held?.at ?? null,
      });
    } else {
      this.#ledger.endByLease(leaseId, { at, endReason });
    }
  }

  #heldOf(worker: string): Map<string, number> {
    let held = this.#held.get(worker);
    if (held === undefined) {
      held = new Map();
      this.#held.set(worker, held);
    }
    return held;
  }

  #bump(
    counts: Map<string, number>,
    platform: string,
    delta: number,
    value: UsageValue,
    origin: Origin,
    at: number,
  ): void {
    const next = Math.max(0, (counts.get(platform) ?? 0) + delta);
    counts.set(platform, next);
    this.#publishCounts(counts, value, origin, at, [platform]);
  }

  #publishCounts(
    counts: ReadonlyMap<string, number>,
    value: UsageValue,
    origin: Origin,
    at: number,
    platforms: readonly string[],
  ): void {
    for (const platform of platforms) {
      if (platform !== "") this.#level(origin, platform, value, counts.get(platform) ?? 0, at);
    }
    let total = 0;
    for (const count of counts.values()) total += count;
    this.#level(origin, "all", value, total, at);
  }

  #level(origin: Origin, platform: string, value: UsageValue, level: number, at: number): void {
    this.#minutes.step(origin.worker, platform, value, level, at);
    if (!this.#options.fleet) return;
    if (!origin.relayed) {
      if (value === "queueDepth" || value === "waiting") {
        this.#minutes.step("*", platform, value, level, at);
      }
      return;
    }
    if (value === "queueDepth") return;
    let byPlatform = this.#levels.get(origin.worker);
    if (byPlatform === undefined) {
      byPlatform = new Map();
      this.#levels.set(origin.worker, byPlatform);
    }
    let byValue = byPlatform.get(platform);
    if (byValue === undefined) {
      byValue = new Map();
      byPlatform.set(platform, byValue);
    }
    byValue.set(value, level);
    this.#fleetTotal(platform, value, at);
  }

  #fleetTotal(platform: string, value: UsageValue, at: number): void {
    let total = 0;
    for (const worker of this.#connected) {
      total += this.#levels.get(worker)?.get(platform)?.get(value) ?? 0;
    }
    this.#minutes.step("*", platform, value, total, at);
  }

  #touch(origin: Origin, at: number): void {
    if (!origin.relayed || this.#connected.has(origin.worker)) return;
    this.#connected.add(origin.worker);
    const held = this.#held.get(origin.worker);
    if (held !== undefined && held.size > 0) {
      this.#publishCounts(held, "leasesHeld", origin, at, [...held.keys()]);
    }
  }

  #capacity(payload: Readonly<Record<string, unknown>>, origin: Origin, at: number): void {
    this.#touch(origin, at);
    for (const [key, figures] of Object.entries(payload)) {
      const found = payloadOf(figures);
      if (key === "ramBudget") {
        const used = amount(found.usedBytes);
        const limit = amount(found.limitBytes);
        if (used !== undefined) this.#level(origin, "all", "ramUsedBytes", used, at);
        if (limit !== undefined) this.#level(origin, "all", "ramLimitBytes", limit, at);
        continue;
      }
      const platform = key === "global" ? "all" : text(key);
      if (platform === undefined || platform === "workerId") continue;
      const running = amount(found.running);
      const reserved = amount(found.reserved);
      const max = amount(found.maxRunning);
      if (running !== undefined && reserved !== undefined) {
        this.#level(origin, platform, "slotsUsed", running + reserved, at);
      }
      if (max !== undefined) this.#level(origin, platform, "slotsMax", max, at);
    }
  }

  #queue(payload: Readonly<Record<string, unknown>>, origin: Origin, at: number): void {
    const depth = amount(payload.depth);
    if (depth === undefined) return;
    this.#touch(origin, at);
    let lines = this.#queues.get(origin.worker);
    if (lines === undefined) {
      lines = { physical: 0, plain: 0 };
      this.#queues.set(origin.worker, lines);
    }
    if (payload.physical === true) lines.physical = depth;
    else lines.plain = depth;
    this.#level(origin, "all", "queueDepth", lines.plain + lines.physical, at);
  }

  #gap(at: number, workerId: string | null): void {
    this.#statements
      .get(
        `INSERT INTO gaps (at, workerId) VALUES (?, ?)
         ON CONFLICT (at) DO UPDATE SET workerId = NULL WHERE excluded.workerId IS NULL`,
      )
      .run(at, workerId);
  }

  #stopping(at: number): void {
    this.#gap(at, null);
    this.#minutes.cut(undefined, at);
  }

  #started(at: number): void {
    this.#minutes.cut(undefined, at);
    this.#minutes.closeOpenRows();
    this.#gap(at, null);
    if (this.#options.fleet) {
      this.#ledger.rejectAllOpen(at, "daemon-restarted");
      this.#loaded = false;
      this.#load();
    }
    for (const [counts, value] of [
      [this.#waiting, "waiting"],
      [this.#held.get("") ?? new Map<string, number>(), "leasesHeld"],
    ] as const) {
      if (counts.size > 0) this.#publishCounts(counts, value, OWN, at, [...counts.keys()]);
    }
  }

  #disconnected(payload: Readonly<Record<string, unknown>>, at: number): void {
    const worker = text(payload.workerId);
    if (worker === undefined) return;
    this.#connected.delete(worker);
    const gone = this.#levels.get(worker);
    this.#levels.delete(worker);
    if (gone !== undefined) {
      for (const [platform, values] of gone) {
        for (const value of values.keys()) this.#fleetTotal(platform, value, at);
      }
    }
    this.#minutes.cut(worker, at);
    this.#gap(at, worker);
  }

  #deviceFact(
    event: string,
    payload: Readonly<Record<string, unknown>>,
    origin: Origin,
    at: number,
  ): void {
    const deviceId = text(payload.deviceId);
    if (deviceId === undefined) return;
    const durationField = DEVICE_FACTS[event];
    const duration = durationField === undefined ? undefined : payload[durationField];
    // why: the doctor marks a device ready with a boot of 0; it booted nothing, so it is no boot fact.
    if (event === "device.ready" && duration === 0) return;
    this.#fact({
      at,
      deviceId,
      durationMs: amount(duration),
      kind: event,
      platform:
        event === "device.provisioned" ? specOf(payload.spec).platform : text(payload.platform),
      workerId: origin.relayed ? origin.worker : undefined,
    });
  }

  #fact(fact: {
    readonly at: number;
    readonly kind: string;
    readonly durationMs: number | undefined;
    readonly platform: string | undefined;
    readonly workerId: string | undefined;
    readonly deviceId: string | undefined;
  }): void {
    this.#statements
      .get(
        `INSERT INTO device_fact_rows (at, kind, durationMs, platform, workerId, deviceId)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.at,
        fact.kind,
        fact.durationMs ?? null,
        fact.platform ?? null,
        fact.workerId ?? null,
        fact.deviceId ?? null,
      );
  }
}

export function createUsageProjector(
  database: SqliteDatabase,
  options: HistoryProjectionOptions,
): ProjectionHandle {
  return new Projector(database, options);
}
