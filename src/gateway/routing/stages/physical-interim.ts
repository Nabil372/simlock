import type { RankStage } from "../pipeline.js";

/** The gateway does not yet see which devices a worker has enrolled, so each worker's own check answers the request. */
export const physicalInterim: RankStage = {
  kind: "rank",
  name: "physical-interim",
  score() {
    return 1;
  },
  settles: true,
};
