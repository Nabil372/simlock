import type { RankStage } from "../pipeline.js";

/**
 * Scores every worker left 1, so the lowest worker id is picked (ADR 0022, interim until #442).
 * A physical request cannot be judged against a worker's catalog or capacity: the gateway does not
 * yet see which devices a worker has enrolled, so each worker's own check answers the request.
 */
export const physicalInterim: RankStage = {
  kind: "rank",
  name: "physical-interim",
  score() {
    return 1;
  },
  settles: true,
};
