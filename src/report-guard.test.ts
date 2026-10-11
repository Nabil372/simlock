import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "report-guard.mjs",
);

function stop(agentType: string, lastMessage: string): string {
  return execFileSync("node", [SCRIPT], {
    input: JSON.stringify({ agent_type: agentType, last_assistant_message: lastMessage }),
    encoding: "utf8",
  });
}

describe("report-guard.mjs", () => {
  it("lets each stage agent stop once its last message holds its report block", () => {
    expect(
      stop("implementer", "```\nissue: 438  branch: task/438  pr: 456  mode: audit\n```"),
    ).toBe("");
    expect(stop("reviewer", "PR: #456  Round: 2  Kind: full  Commit: abc")).toBe("");
    expect(stop("hardware-verifier", "PR: #456  Hardware: pass\nRan: e2e/x.test.ts")).toBe("");
  });

  it("blocks a stage agent that stops with an interim message instead of its report", () => {
    const output = stop(
      "implementer",
      "Four agents are killing the mutants. I'm waiting for them.",
    );

    expect(JSON.parse(output)).toMatchObject({ decision: "block" });
    expect(JSON.parse(output).reason).toContain("report block");
  });

  it("blocks a reviewer whose block belongs to another agent, and lets any other agent stop", () => {
    expect(JSON.parse(stop("reviewer", "PR: #456  Hardware: pass"))).toMatchObject({
      decision: "block",
    });
    expect(stop("Explore", "src/a.ts:12")).toBe("");
  });
});
