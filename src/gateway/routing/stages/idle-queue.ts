import type { FilterStage } from "../pipeline.js";

/** `queueDepth` counts the virtual line, so a worker with only physical waiters still takes a virtual request. A physical request never runs this stage: the physical stages leave out the queue depth, since a worker matches its own physical waiters per model. */
export const idleQueue: FilterStage = {
  keeps(worker) {
    return worker.queueDepth === 0;
  },
  kind: "filter",
};
