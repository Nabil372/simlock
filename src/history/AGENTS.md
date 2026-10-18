# Event history

Does: the durable record of every business event, one SQLite file, `history.db`, in the data directory.
Entry: `index.ts` → `createEventHistory()`, `openHistoryReader()`, `HistoryProjectionDefinition`, `HISTORY_PROJECTIONS`, `HISTORY_DB_NAME`.
Uses: bus (type, subscription), contract (`EVENT_ID_PATTERN`), ports (`SqliteOpener`, `Filesystem`, `Clock`, `Logger`). Never imports: core, leasing, drivers, gateway. Nothing required imports it.
Flows: [startup](../../docs/internal/flows/startup.md). Catalog: [EVENTS.md](../../docs/internal/EVENTS.md).

## Files

| File           | Role                                                                |
| -------------- | ------------------------------------------------------------------- |
| `index.ts`     | the handle (`replay`, `status`, `start`, `stop`) and the CLI reader |
| `database.ts`  | pragmas, schema, `quick_check`, the read query, lock-error test     |
| `prune.ts`     | age, size, projection prune, vacuum and checkpoint                  |
| `set-aside.ts` | renames a damaged file and its `-wal` and `-shm`                    |
| `projections/` | `HISTORY_PROJECTIONS`: one directory per projection (none yet)      |
| `testing.ts`   | a reader, a seeder, a probing opener and a fixed handle for tests   |

## How it works

1. **Create** — the factory subscribes to the bus and touches no file. `status()` is `{ opened: false, writing: false }`; `replay` answers the ring.
2. **Start** — `start()` runs once the daemon holds its socket: load `node:sqlite`, open `history.db`, `busy_timeout=5000`, `auto_vacuum=INCREMENTAL`, `journal_mode=WAL`, `synchronous=NORMAL`, schema, `quick_check`. A file that fails to open or check is set aside (`history.db.damaged-<now>`, `-wal` and `-shm` first, main file last), and a fresh one opens.
3. **Catch up** — the ring's events are written (`INSERT OR IGNORE` by `id`). After a set-aside only the events seen since the factory ran are.
4. **Write** — each event is one transaction: `BEGIN`, insert the row, run every projection's `apply` when the row is new, `COMMIT`.
5. **Prune** — after start and every hour: delete rows older than `eventLog.retention`, then the oldest 1 000 at a time while the stored size is over `eventLog.maxBytes`, then each projection's `prune`, then `incremental_vacuum` and `wal_checkpoint(TRUNCATE)`.
6. **Read** — `replay({ sinceTs })` selects `timestamp > ?` ordered by timestamp, seq, rowid; a row whose id fails `EVENT_ID_PATTERN` is skipped. `openHistoryReader` does the same read-only for the CLI when no daemon answers; a missing file is empty, an unreadable one throws.
7. **Stop** — `stop()` cancels the timer and closes the file. A `start()` still awaiting closes what it opened and returns.

## State and timers

| What                                     | Default                   | Key                  |
| ---------------------------------------- | ------------------------- | -------------------- |
| Keep events for                          | 7 days                    | `eventLog.retention` |
| Cap on the stored size of the event rows | 256 MiB (at least 16 MiB) | `eventLog.maxBytes`  |
| Prune                                    | after start, then hourly  | none                 |
| Wait on another connection's lock        | 5 s                       | none                 |

- `status()` feeds `status.get` `history`: `opened`, `writing`, `setAsideAt`.
- A failed write rolls back, logs one `error`, and sets `writing` false until restart. A storage failure also sends `replay` back to the ring; a projection failure leaves the file readable.
- A lock held past 5 s is never damage: nothing is set aside.
- The file lives on the real disk: the daemon builds the history with its own `NodeFilesystem`.

## Rules

- The history deletes rows, never files. A set-aside file is renamed, never deleted.
- Only the socket-claim holder starts it, so a second daemon never opens, checks or renames the file.
- A failing write never reaches the emitter (events rule 5).
- The history never names a projection (architecture rule 21); the host hands `HISTORY_PROJECTIONS` in.

## Known gaps

- **Power loss.** The last few commits can be lost (`synchronous=NORMAL`).
- **Old `events.jsonl`.** Left untouched and never read.
