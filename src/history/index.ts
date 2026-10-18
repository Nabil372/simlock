import type { EventBus, EventEnvelope } from "../bus/index.js";
import type { Clock, Filesystem, Logger, SqliteDatabase, SqliteOpener } from "../ports/index.js";

export const HISTORY_DB_NAME = "history.db";

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

export function createEventHistory(options: EventHistoryOptions): EventHistoryHandle {
  return {
    replay: (input = {}) => Promise.resolve(options.bus.replay(input)),
    status: () => ({ opened: false, writing: false }),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

export function openHistoryReader(_options: {
  readonly sqlite: SqliteOpener;
  readonly filesystem: Filesystem;
  readonly dataDirectory: string;
}): { read(input: { readonly sinceTs: number }): Promise<EventEnvelope[]> } {
  return { read: () => Promise.resolve([]) };
}
