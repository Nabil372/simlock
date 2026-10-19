import type { Statements } from "./statements.js";
import { MINUTE_MS, minuteOf, USAGE_VALUES, type UsageValue } from "./types.js";

interface Figure {
  peak: number;
  last: number | null;
  integral: number;
}

interface MinuteRowData {
  knownMs: number;
  carryUntil: number | null;
  readonly figures: Map<UsageValue, Figure>;
}

interface Held {
  readonly level: number;
  readonly since: number;
  readonly settled: number;
  readonly settledMinute: number;
}

interface KeyState {
  readonly worker: string;
  readonly platform: string;
  known: boolean;
  lastAt: number;
  lastRowMinute: number;
  readonly values: Map<UsageValue, Held>;
}

const COLUMNS = [
  "workerId",
  "platform",
  "minute",
  "knownMs",
  "carryUntil",
  ...USAGE_VALUES.flatMap((value) => [`${value}Peak`, `${value}Last`, `${value}Integral`]),
];
const SAVE_SQL = `INSERT OR REPLACE INTO minute_rows (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
const LOAD_SQL = `SELECT ${COLUMNS.join(", ")} FROM minute_rows WHERE workerId = ? AND platform = ? AND minute = ?`;
const CLOSE_OPEN_SQL = `UPDATE minute_rows SET carryUntil = minute + ${MINUTE_MS}
  WHERE carryUntil IS NULL AND minute = (
    SELECT MAX(later.minute) FROM minute_rows later
    WHERE later.workerId = minute_rows.workerId AND later.platform = minute_rows.platform)`;

// why: a row's integral is taken through the minute's end as if the last value held, so a reader needs no row for the minutes after; a cut takes the rest back off.
export class MinuteRecorder {
  readonly #statements: Statements;
  readonly #states = new Map<string, KeyState>();

  constructor(statements: Statements) {
    this.#statements = statements;
  }

  step(
    worker: string,
    platform: string,
    value: UsageValue,
    level: number,
    timestamp: number,
  ): void {
    const state = this.#state(worker, platform);
    if (state.known && state.values.get(value)?.level === level) return;
    // why: a worker's clock may run behind this one; a step stamped before the key's last counts there.
    const at = Math.max(timestamp, state.lastAt);
    const minute = minuteOf(at);
    const end = minute + MINUTE_MS;
    let row = this.#load(worker, platform, minute);
    if (row === undefined) {
      row = { carryUntil: null, figures: new Map(), knownMs: state.known ? MINUTE_MS : end - at };
      if (state.known) carryInto(row, state);
    } else if (!state.known && row.carryUntil !== null) {
      row.knownMs += end - at;
    }
    const figure = row.figures.get(value);
    const held = state.known ? state.values.get(value) : undefined;
    const previous = state.known ? held?.level : (figure?.last ?? undefined);
    // why: a level replaced in the same ms it began held for no time, so it is no peak of the minute.
    let settled = figure?.peak ?? Number.NEGATIVE_INFINITY;
    if (held !== undefined) {
      settled = held.settledMinute === minute ? held.settled : Number.NEGATIVE_INFINITY;
      if (at - Math.max(held.since, minute) > 0) settled = Math.max(settled, held.level);
    }
    if (figure === undefined) {
      row.figures.set(value, { integral: level * (end - at), last: level, peak: level });
    } else {
      figure.integral += (level - (previous ?? 0)) * (end - at);
      figure.peak = Math.max(settled, level);
      figure.last = level;
    }
    row.carryUntil = null;
    this.#save(worker, platform, minute, row);
    state.known = true;
    state.values.set(value, { level, settled, settledMinute: minute, since: at });
    state.lastAt = at;
    state.lastRowMinute = minute;
  }

  cut(worker: string | undefined, timestamp: number): void {
    for (const state of this.#states.values()) {
      if (state.known && (worker === undefined || state.worker === worker)) {
        this.#end(state, timestamp);
      }
    }
  }

  closeOpenRows(): void {
    this.#statements.get(CLOSE_OPEN_SQL).run();
  }

  forget(): void {
    this.#states.clear();
  }

  #end(state: KeyState, timestamp: number): void {
    const at = Math.max(timestamp, state.lastAt);
    const minute = minuteOf(at);
    let row = this.#load(state.worker, state.platform, minute);
    if (row === undefined && at > minute) {
      row = { carryUntil: null, figures: new Map(), knownMs: MINUTE_MS };
      carryInto(row, state);
    }
    if (row !== undefined) {
      const tail = minute + MINUTE_MS - at;
      row.knownMs = Math.max(0, row.knownMs - tail);
      for (const figure of row.figures.values()) {
        if (figure.last !== null) figure.integral -= figure.last * tail;
        figure.last = null;
      }
      row.carryUntil = at;
      this.#save(state.worker, state.platform, minute, row);
    } else {
      const lastRow = this.#load(state.worker, state.platform, state.lastRowMinute);
      if (lastRow !== undefined) {
        lastRow.carryUntil = at;
        this.#save(state.worker, state.platform, state.lastRowMinute, lastRow);
      }
    }
    state.known = false;
    state.values.clear();
    state.lastAt = at;
  }

  #state(worker: string, platform: string): KeyState {
    const key = `${worker}\u0000${platform}`;
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { known: false, lastAt: 0, lastRowMinute: 0, platform, values: new Map(), worker };
      this.#states.set(key, state);
    }
    return state;
  }

  #load(worker: string, platform: string, minute: number): MinuteRowData | undefined {
    const stored = this.#statements.get(LOAD_SQL).get(worker, platform, minute);
    if (stored === undefined) return undefined;
    const figures = new Map<UsageValue, Figure>();
    for (const value of USAGE_VALUES) {
      const peak = stored[`${value}Peak`];
      if (typeof peak !== "number") continue;
      const last = stored[`${value}Last`];
      figures.set(value, {
        integral: Number(stored[`${value}Integral`]),
        last: typeof last === "number" ? last : null,
        peak,
      });
    }
    const carryUntil = stored.carryUntil;
    return {
      carryUntil: typeof carryUntil === "number" ? carryUntil : null,
      figures,
      knownMs: Number(stored.knownMs),
    };
  }

  #save(worker: string, platform: string, minute: number, row: MinuteRowData): void {
    this.#statements.get(SAVE_SQL).run(
      worker,
      platform,
      minute,
      row.knownMs,
      row.carryUntil,
      ...USAGE_VALUES.flatMap((value) => {
        const figure = row.figures.get(value);
        return figure === undefined
          ? [null, null, null]
          : [figure.peak, figure.last, figure.integral];
      }),
    );
  }
}

function carryInto(row: MinuteRowData, state: KeyState): void {
  for (const [name, { level }] of state.values) {
    row.figures.set(name, { integral: level * MINUTE_MS, last: level, peak: level });
  }
}
