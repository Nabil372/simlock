import { parentPort } from "node:worker_threads";

import type { UsageOutput } from "../../contract/index.js";
import { openUsageReads } from "../../history/index.js";
import { filterSqliteExperimentalWarning, NodeSqliteOpener } from "../../ports/index.js";
import { computeUsage } from "./compute-usage.js";

export interface ReadRequest {
  readonly id: number;
  readonly historyPath: string;
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  readonly fleet: boolean;
  readonly workers: readonly { readonly id: string; readonly label?: string | undefined }[];
}

export type ReadResponse =
  | { readonly id: number; readonly figures: UsageOutput }
  | { readonly id: number; readonly notKept: number }
  | { readonly id: number; readonly error: string };

async function read(request: ReadRequest): Promise<ReadResponse> {
  const database = await new NodeSqliteOpener().open(request.historyPath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    // why: one read transaction gives all four reads the same snapshot while the writer commits.
    database.exec("BEGIN");
    const reads = openUsageReads(database);
    const oldestTs = reads.oldestTs();
    if (oldestTs !== undefined && oldestTs > request.to) {
      return { id: request.id, notKept: oldestTs };
    }
    const range = { from: request.from, to: request.to };
    const figures = computeUsage({
      bucketMs: request.bucketMs,
      deviceFacts: reads.deviceFacts(range),
      fleet: request.fleet,
      minutes: (workerId, platform) =>
        reads.minuteBuckets({ ...range, bucketMs: request.bucketMs, platform, workerId }),
      oldestTs,
      requestRows: reads.requestRows(range),
      window: range,
      workers: request.workers,
    });
    database.exec("COMMIT");
    return { figures, id: request.id };
  } finally {
    database.close();
  }
}

if (parentPort !== null) {
  const port = parentPort;
  filterSqliteExperimentalWarning();
  port.on("message", (request: ReadRequest) => {
    read(request).then(
      (response) => port.postMessage(response),
      (error: unknown) =>
        port.postMessage({
          error: error instanceof Error ? error.message : String(error),
          id: request.id,
        } satisfies ReadResponse),
    );
  });
}
