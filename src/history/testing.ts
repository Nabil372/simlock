import { EventBus, type EventEnvelope } from "../bus/index.js";
import {
  FakeClock,
  MemoryFilesystem,
  NodeFilesystem,
  NodeSqliteOpener,
  NoopLogger,
  type SqliteDatabase,
  type SqliteOpener,
  type SqliteStatement,
} from "../ports/index.js";
import {
  createEventHistory,
  type EventHistoryHandle,
  type EventHistoryStatus,
  type HistoryProjectionDefinition,
  openHistoryReader,
  type ProjectionHandle,
} from "./index.js";

export function plainProjection(
  name: string,
  create: (database: SqliteDatabase) => Omit<ProjectionHandle, "rebuild">,
): HistoryProjectionDefinition {
  return {
    check: () => true,
    create,
    migrations: [],
    name,
    version: 0,
  };
}

export function readHistoryEvents(dataDirectory: string, sinceTs = 0): Promise<EventEnvelope[]> {
  return openHistoryReader({
    dataDirectory,
    filesystem: new NodeFilesystem(),
    sqlite: new NodeSqliteOpener(),
  }).read({ sinceTs });
}

export interface ProbeConnection {
  readonly path: string;
  readonly database: SqliteDatabase;
  readonly readOnly: boolean;
  closed: boolean;
}

export type ProbeCall =
  | { readonly kind: "open"; readonly path: string; readonly connection: number }
  | { readonly kind: "exec" | "prepare"; readonly sql: string; readonly connection: number };

export interface ProbeOptions {
  readonly beforeOpen?: (call: { readonly connection: number }) => Promise<void>;
  readonly fault?: (call: ProbeCall) => void;
  readonly answer?: (call: {
    readonly sql: string;
    readonly connection: number;
  }) => Record<string, unknown>[] | undefined;
}

export class ProbeSqliteOpener implements SqliteOpener {
  readonly connections: ProbeConnection[] = [];
  opens = 0;
  readonly #inner = new NodeSqliteOpener();
  readonly #options: ProbeOptions;

  constructor(options: ProbeOptions = {}) {
    this.#options = options;
  }

  async open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase> {
    const connection = this.opens;
    this.opens += 1;
    await this.#options.beforeOpen?.({ connection });
    this.#options.fault?.({ connection, kind: "open", path });
    const database = await this.#inner.open(path, options);
    const probe: ProbeConnection = { closed: false, database, path, readOnly: options.readOnly };
    this.connections.push(probe);
    return {
      close: () => {
        probe.closed = true;
        database.close();
      },
      exec: (sql) => {
        this.#options.fault?.({ connection, kind: "exec", sql });
        database.exec(sql);
      },
      prepare: (sql) => {
        this.#options.fault?.({ connection, kind: "prepare", sql });
        const answered = this.#options.answer?.({ connection, sql });
        if (answered !== undefined) return answeredStatement(answered);
        return database.prepare(sql);
      },
    };
  }
}

function answeredStatement(rows: Record<string, unknown>[]): SqliteStatement {
  return {
    all: () => rows,
    get: () => rows[0],
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
  };
}

export function fixedEventHistory(status: EventHistoryStatus): EventHistoryHandle {
  return {
    replay: () => Promise.resolve([]),
    start: () => Promise.resolve(),
    status: () => status,
    stop: () => Promise.resolve(),
  };
}

export async function seedHistory(
  dataDirectory: string,
  timestamps: readonly number[],
): Promise<void> {
  const clock = new FakeClock(0);
  let nextId = 0;
  const bus = new EventBus(clock, 1_000, undefined, { generate: () => String((nextId += 1)) });
  const history = createEventHistory({
    bus,
    clock,
    config: { maxBytes: Number.MAX_SAFE_INTEGER, retention: Number.MAX_SAFE_INTEGER },
    dataDirectory,
    filesystem: new NodeFilesystem(),
    logger: new NoopLogger(),
    projectionOptions: { fleet: false, metricsRetentionMs: Number.MAX_SAFE_INTEGER },
    projections: [],
    sqlite: new NodeSqliteOpener(),
  });
  await history.start();
  for (const [index, timestamp] of timestamps.entries()) {
    clock.advance(timestamp - clock.now());
    bus.emit("daemon.stopping", { reason: `r${index + 1}` }, "daemon");
  }
  await history.stop();
}

export function ringEventHistory(bus: EventBus): EventHistoryHandle {
  return createEventHistory({
    bus,
    clock: new FakeClock(0),
    config: { maxBytes: Number.MAX_SAFE_INTEGER, retention: Number.MAX_SAFE_INTEGER },
    dataDirectory: "/unused",
    filesystem: new MemoryFilesystem(),
    logger: new NoopLogger(),
    projectionOptions: { fleet: false, metricsRetentionMs: Number.MAX_SAFE_INTEGER },
    projections: [],
    sqlite: new NodeSqliteOpener(),
  });
}
