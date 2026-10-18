import { join } from "node:path";

import type { EventBus, EventEnvelope } from "../bus/index.js";
import {
  type Clock,
  type Filesystem,
  isMissingPathError,
  type Logger,
  type SqliteDatabase,
  type SqliteOpener,
  SqliteUnavailableError,
} from "../ports/index.js";
import {
  BUSY_TIMEOUT_MS,
  configureDatabase,
  envelopeSize,
  INSERT_EVENT_SQL,
  isLockError,
  passesQuickCheck,
  selectEventsSince,
} from "./database.js";
import { HISTORY_DB_NAME } from "./names.js";
import { pruneHistory, totalEventBytes } from "./prune.js";
import { setAsideDamagedHistory } from "./set-aside.js";

export { HISTORY_DB_NAME } from "./names.js";

const PRUNE_INTERVAL_MS = 3_600_000;

export interface HistoryProjectionDefinition {
  readonly name: string;
  create(database: SqliteDatabase): {
    apply(envelope: EventEnvelope): void;
    prune(now: number): void;
  };
}

export interface EventHistoryStatus {
  readonly opened: boolean;
  readonly writing: boolean;
  readonly setAsideAt?: number;
}

export interface EventHistoryHandle {
  replay(input?: { readonly sinceTs?: number }): Promise<EventEnvelope[]>;
  status(): EventHistoryStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface EventHistoryOptions {
  readonly bus: EventBus;
  readonly sqlite: SqliteOpener;
  readonly filesystem: Filesystem;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataDirectory: string;
  readonly config: { readonly retention: number; readonly maxBytes: number };
  readonly projections: readonly HistoryProjectionDefinition[];
}

type Projector = ReturnType<HistoryProjectionDefinition["create"]>;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class EventHistory implements EventHistoryHandle {
  readonly #options: EventHistoryOptions;
  readonly #path: string;
  #database: SqliteDatabase | undefined;
  #projectors: Projector[] = [];
  #stored = 0;
  #opened = false;
  #writing = false;
  #readable = false;
  #setAsideAt: number | undefined;
  #started = false;
  #stopped = false;
  #timer: ReturnType<Clock["setTimer"]> | undefined;

  constructor(options: EventHistoryOptions) {
    this.#options = options;
    this.#path = join(options.dataDirectory, HISTORY_DB_NAME);
    options.bus.subscribeAll((envelope) => this.#write(envelope));
  }

  status(): EventHistoryStatus {
    return {
      opened: this.#opened,
      writing: this.#writing,
      ...(this.#setAsideAt === undefined ? {} : { setAsideAt: this.#setAsideAt }),
    };
  }

  async replay(input: { readonly sinceTs?: number } = {}): Promise<EventEnvelope[]> {
    const { bus, logger } = this.#options;
    if (input.sinceTs === undefined) return bus.replay();
    const database = this.#database;
    if (database === undefined || !this.#readable) return bus.replay({ sinceTs: input.sinceTs });
    try {
      return selectEventsSince(database, input.sinceTs);
    } catch (error: unknown) {
      logger.warn("History read failed; replaying from memory", {
        error: describe(error),
        path: this.#path,
      });
      return bus.replay({ sinceTs: input.sinceTs });
    }
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const database = await this.#openChecked();
    if (database === undefined) return;
    if (this.#stopped) {
      closeQuietly(database);
      return;
    }
    // why: nothing below awaits, so no event can land between the ring's copy and the live writer
    this.#database = database;
    try {
      this.#projectors = this.#options.projections.map((projection) => projection.create(database));
      this.#stored = totalEventBytes(database);
    } catch (error: unknown) {
      this.#options.logger.error("History could not be prepared; events are not written", {
        error: describe(error),
        path: this.#path,
      });
      this.#database = undefined;
      closeQuietly(database);
      return;
    }
    this.#opened = true;
    this.#writing = true;
    this.#readable = true;
    if (this.#setAsideAt === undefined) {
      for (const envelope of this.#options.bus.replay()) this.#write(envelope);
    }
    this.#prune();
    this.#arm();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) this.#options.clock.cancel(this.#timer);
    this.#timer = undefined;
    const database = this.#database;
    this.#database = undefined;
    this.#opened = false;
    this.#writing = false;
    if (database !== undefined) closeQuietly(database);
  }

  async #openChecked(): Promise<SqliteDatabase | undefined> {
    const { logger } = this.#options;
    const first = await this.#tryOpen();
    if (first.database !== undefined || first.damage === undefined) return first.database;
    if (this.#stopped) return undefined;
    const now = this.#options.clock.now();
    let damaged: string;
    try {
      damaged = await setAsideDamagedHistory(
        this.#options.filesystem,
        this.#options.dataDirectory,
        now,
      );
    } catch (error: unknown) {
      logger.error("A damaged history could not be set aside; events are not written", {
        error: describe(error),
        path: this.#path,
      });
      return undefined;
    }
    this.#setAsideAt = now;
    logger.error("The history was damaged; it was set aside and a fresh one started", {
      damagedPath: damaged,
      error: first.damage,
      path: this.#path,
    });
    if (this.#stopped) return undefined;
    return (await this.#tryOpen()).database;
  }

  async #tryOpen(): Promise<{ database?: SqliteDatabase; damage?: string }> {
    const { logger, sqlite } = this.#options;
    let database: SqliteDatabase | undefined;
    try {
      database = await sqlite.open(this.#path, { readOnly: false });
      if (this.#stopped) return { database };
      configureDatabase(database);
      if (!passesQuickCheck(database)) {
        closeQuietly(database);
        return { damage: "quick_check did not answer ok" };
      }
      return { database };
    } catch (error: unknown) {
      if (database !== undefined) closeQuietly(database);
      if (error instanceof SqliteUnavailableError) {
        logger.error("node:sqlite is not available; the event history needs Node 22.13 or later", {
          error: describe(error),
        });
        return {};
      }
      if (isLockError(error)) {
        logger.error("The history is locked by another process; events are not written", {
          error: describe(error),
          path: this.#path,
          waitedMs: BUSY_TIMEOUT_MS,
        });
        return {};
      }
      if (this.#setAsideAt !== undefined) {
        logger.error("The fresh history could not be opened; events are not written", {
          error: describe(error),
          path: this.#path,
        });
        return {};
      }
      return { damage: describe(error) };
    }
  }

  #write(envelope: EventEnvelope): void {
    const database = this.#database;
    if (!this.#writing || database === undefined) return;
    try {
      const json = JSON.stringify(envelope);
      const size = envelopeSize(json);
      database.exec("BEGIN");
      let added = 0;
      let inProjection = false;
      try {
        const result = database
          .prepare(INSERT_EVENT_SQL)
          .run(envelope.id, envelope.timestamp, envelope.seq, size, json);
        if (Number(result.changes) === 1) {
          added = size;
          inProjection = true;
          for (const projector of this.#projectors) projector.apply(envelope);
          inProjection = false;
        }
        database.exec("COMMIT");
      } catch (error: unknown) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // why: the first error is the one to report
        }
        // why: a projection failure rolls back cleanly and leaves the file readable; a failed insert makes replay use the ring
        if (!inProjection) this.#readable = false;
        throw error;
      }
      this.#stored += added;
    } catch (error: unknown) {
      this.#writing = false;
      this.#options.logger.error("History write failed; events are no longer written", {
        error: describe(error),
        path: this.#path,
      });
    }
  }

  #prune(): void {
    const database = this.#database;
    if (database === undefined) return;
    try {
      this.#stored = pruneHistory(
        database,
        {
          maxBytes: this.#options.config.maxBytes,
          now: this.#options.clock.now(),
          projections: this.#projectors,
          retention: this.#options.config.retention,
        },
        this.#stored,
      );
    } catch (error: unknown) {
      this.#options.logger.warn("History prune failed; the next try is in an hour", {
        error: describe(error),
        path: this.#path,
      });
    }
  }

  #arm(): void {
    if (this.#stopped) return;
    this.#timer = this.#options.clock.setTimer(PRUNE_INTERVAL_MS, () => {
      this.#timer = undefined;
      if (this.#stopped) return;
      this.#prune();
      this.#arm();
    });
  }
}

function closeQuietly(database: SqliteDatabase): void {
  try {
    database.close();
  } catch {
    // why: a close that fails leaves the file as SQLite's recovery expects it
  }
}

export function createEventHistory(options: EventHistoryOptions): EventHistoryHandle {
  return new EventHistory(options);
}

export function openHistoryReader(options: {
  readonly sqlite: SqliteOpener;
  readonly filesystem: Filesystem;
  readonly dataDirectory: string;
}): { read(input: { readonly sinceTs: number }): Promise<EventEnvelope[]> } {
  const path = join(options.dataDirectory, HISTORY_DB_NAME);
  return {
    async read({ sinceTs }) {
      try {
        await options.filesystem.stat(path);
      } catch (error: unknown) {
        if (isMissingPathError(error)) return [];
        throw error;
      }
      const database = await options.sqlite.open(path, { readOnly: true });
      try {
        database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
        return selectEventsSince(database, sinceTs);
      } finally {
        closeQuietly(database);
      }
    },
  };
}
