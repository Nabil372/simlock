import type { FilterStage } from "../pipeline.js";

/** Keeps a worker whose own queue is empty (ADR 0009 §2, stage 4), warm device or not: a worker
 * with a local waiter refuses every `noWait` request (ADR 0005 requirement 12). A worker that has
 * not reported its queue depth is not known to be idle. `queueDepth` counts the virtual line, so
 * a worker with only physical waiters still takes a virtual request, and a physical request is not
 * judged by it at all: a worker matches its own physical waiters per model (ADR 0022). */
export const idleQueue: FilterStage = {
  keeps(worker, request) {
    return request.physical === true || worker.queueDepth === 0;
  },
  kind: "filter",
};
