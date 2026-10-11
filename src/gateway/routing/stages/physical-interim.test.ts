import { describe, expect, it } from "vitest";

import { catalogFixture, statusFixture } from "../../test-support.js";
import type { WorkerView } from "../../worker-registry.js";
import { runStages, type RankStage } from "../pipeline.js";
import { physicalInterim } from "./physical-interim.js";

function view(id: string): WorkerView {
  return {
    capacity: statusFixture().capacity,
    catalog: catalogFixture([{ models: ["iPhone 17"], platform: "ios", runtimes: ["26.0"] }])
      .platforms,
    catalogReadAt: 1,
    connection: "connected",
    devices: [],
    drained: false,
    health: "running",
    id,
    lastSeenAt: 1,
    leases: [],
    queueDepth: 0,
  };
}

const REQUEST = { model: "iPhone 17", physical: true, platform: "ios" as const };

describe("physical-interim", () => {
  it("settles the pick on the lowest worker id, so a later rank cannot narrow it", () => {
    const preferLast: RankStage = {
      kind: "rank",
      name: "prefer-last",
      score: (worker) => (worker.id === "wrk_b" ? 1 : 0.5),
      settles: true,
    };

    const pick = runStages([physicalInterim, preferLast], REQUEST, [view("wrk_b"), view("wrk_a")]);

    expect(pick).toStrictEqual({ stage: "physical-interim", workerId: "wrk_a" });
  });
});
