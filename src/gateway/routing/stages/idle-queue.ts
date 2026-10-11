import type { FilterStage } from "../pipeline.js";

/** `queueDepth` counts the virtual line, so a worker with only physical waiters still takes a virtual request; a physical request is not judged by it, since a worker matches its own physical waiters per model. */
export const idleQueue: FilterStage = {
  keeps(worker, request) {
    return request.physical === true || worker.queueDepth === 0;
  },
  kind: "filter",
};
