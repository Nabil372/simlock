import { matchRequest, physicalMatch } from "../request-match.js";
import type { FilterStage } from "../pipeline.js";

/**
 * Keeps a worker whose catalog pairs the requested model with the requested runtime (ADR 0009
 * §2, stage 2; §3 for the match). A download never makes a worker able to serve.
 */
export const canServe: FilterStage = {
  keeps(worker, request) {
    if (request.physical === true) return physicalMatch(worker, request, "enrolled");
    return matchRequest(worker, request) !== undefined;
  },
  appliesToPhysical: true,
  kind: "filter",
};
