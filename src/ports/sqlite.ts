export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
  run(...parameters: SqliteValue[]): SqliteRunResult;
  get(...parameters: SqliteValue[]): Record<string, unknown> | undefined;
  all(...parameters: SqliteValue[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteOpener {
  open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase>;
}

export class SqliteUnavailableError extends Error {}

export class NodeSqliteOpener implements SqliteOpener {
  async open(path: string, options: { readonly readOnly: boolean }): Promise<SqliteDatabase> {
    let engine: typeof import("node:sqlite");
    try {
      engine = await import("node:sqlite");
    } catch (error: unknown) {
      throw new SqliteUnavailableError(error instanceof Error ? error.message : String(error));
    }
    return new engine.DatabaseSync(path, { readOnly: options.readOnly });
  }
}

const SQLITE_WARNING_PREFIX = "SQLite is an experimental feature";

export function filterSqliteExperimentalWarning(): void {
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const first = rest[0];
    const type = typeof first === "string" ? first : (first as { type?: string } | undefined)?.type;
    const name = typeof warning === "string" ? type : (type ?? warning.name);
    const message = typeof warning === "string" ? warning : warning.message;
    if (name === "ExperimentalWarning" && message.startsWith(SQLITE_WARNING_PREFIX)) return;
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
