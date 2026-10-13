import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "scripts",
  "merge-pr.sh",
);

interface Fleet {
  /** The red check's bucket before a re-run: `fail` or `cancel`. */
  readonly bucket: "fail" | "cancel";
  /** What `gh run view --log-failed` prints for the red job. */
  readonly log: string;
  /** Bodies of the open `flaky-test` issues. */
  readonly flakyIssues: string;
  /** Whether the check passes after a re-run. */
  readonly passesOnRerun: boolean;
  readonly refusedAsStacked?: boolean;
  readonly body?: string;
  readonly qualityAlone?: boolean;
}

const VALID_BODY =
  "## Review\n\nSpec review: skipped. Code review: skipped. Claims review: skipped.\n" +
  "Rounds: 0. Tokens: n/a.\n\n*Written by an agent.*\n";

// why: CI's red job comes with a red Quality check that needs it, as on GitHub, so a gate that
// judged Quality instead of the job would show here.
function gate(fleet: Fleet) {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-"));
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  write("log", fleet.log);
  write("flaky", fleet.flakyIssues);
  write("body", fleet.body ?? VALID_BODY);
  const after = fleet.passesOnRerun ? "pass" : fleet.bucket;
  // The fake answers by the --json fields asked for; it ignores the -q filter, so each answer
  // is already in the shape the filter would print.
  write(
    "gh",
    `#!/bin/sh
d=${JSON.stringify(dir)}
state() { if [ -f "$d/reran" ]; then echo ${after}; else echo ${fleet.bucket}; fi; }
quality() { if [ "$(state)" = pass ]; then echo pass; else echo fail; fi; }
case "$*" in
  "repo view --json nameWithOwner"*) echo o/r ;;
  "api repos/o/r/stacks?pull_request=7"*) ;;
  "pr view 7 --json state"*) echo OPEN ;;
  "pr view 7 --json isDraft"*) echo false ;;
  "pr view 7 --json labels"*) ;;
  "pr view 7 --json body"*) cat "$d/body" ;;
  "pr view 7 --json headRefName"*) echo chore/x ;;
  "pr view 7 --json mergeable"*) echo MERGEABLE ;;
${
  fleet.qualityAlone === true
    ? `  "pr checks 7 --json name,bucket"*) echo "pass E2E (2/3)"; echo "$(state) Quality" ;;
  "pr checks 7 --json bucket,link"*)
    b=$(state); [ "$b" = pass ] || echo "$b https://github.com/o/r/actions/runs/77/job/6 Quality" ;;`
    : `  "pr checks 7 --json name,bucket"*) echo "$(state) E2E (2/3)"; echo "$(quality) Quality" ;;
  "pr checks 7 --json bucket,link"*)
    b=$(state); [ "$b" = pass ] || {
      echo "$b https://github.com/o/r/actions/runs/77/job/5 E2E (2/3)"
      echo "fail https://github.com/o/r/actions/runs/77/job/6 Quality"
    } ;;`
}
  "issue list --label flaky-test"*) cat "$d/flaky" ;;
  "run view 77 --log-failed") cat "$d/log" ;;
  "run rerun 77 --failed") echo rerun >>"$d/reran" ;;
${
  fleet.refusedAsStacked === true
    ? `  "pr merge 7 --squash") echo "Pull request #7 is part of a stack" >&2; exit 1 ;;
  "stack merge 7 --yes --squash") touch "$d/merged" ;;`
    : `  "pr merge 7 --squash") touch "$d/merged" ;;`
}
  *) echo "fake gh: unexpected: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  let status = 0;
  let output = "";
  try {
    output = execFileSync("sh", [SCRIPT, "7"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MERGE_PR_POLL_SECONDS: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    status = failed.status;
    output = failed.stdout + failed.stderr;
  }
  return {
    status,
    output,
    reruns: existsSync(join(dir, "reran"))
      ? readFileSync(join(dir, "reran"), "utf8").trim().split("\n").length
      : 0,
    merged: existsSync(join(dir, "merged")),
  };
}

const FLAKY_LOG =
  "E2E (2/3)\tE2E tests\t2026-10-06T10:00:00Z  FAIL  e2e/gateway-fast-fail.test.ts > a gateway fails fast\n" +
  "E2E (2/3)\tE2E tests\t2026-10-06T10:00:00Z  ✓ e2e/lease-lifecycle.test.ts (12 tests)\n";
const FLAKY_ISSUE =
  "Fails under load on main.\nTest: `e2e/gateway-fast-fail.test.ts` > a gateway fails fast\n";

describe("merge-pr.sh on a stack's last open PR", () => {
  it("merges it with gh stack merge when GitHub refuses a plain merge of a stacked PR", () => {
    const result = gate({
      bucket: "cancel",
      log: "",
      flakyIssues: "",
      passesOnRerun: true,
      refusedAsStacked: true,
    });

    expect(result.merged).toBe(true);
    expect(result.status).toBe(0);
  });
});

describe("merge-pr.sh body gate", () => {
  it("does not merge a PR whose body fails pr-body-check.mjs, before it looks at CI", () => {
    const result = gate({
      bucket: "fail",
      log: "",
      flakyIssues: "",
      passesOnRerun: true,
      body: "## Review\n\nLooks good.\n\n*Written by an agent.*\n",
    });
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
    expect(result.output).toContain("counts line");
    expect(result.output).toContain("fails pr-body-check.mjs");
    expect(result.output).not.toContain("CI not green");
  });
});

describe("merge-pr.sh re-run of red CI", () => {
  it("re-runs a job that failed only in a test an open flaky-test issue names, once, and merges when the re-run passes", () => {
    const result = gate({
      bucket: "fail",
      log: FLAKY_LOG,
      flakyIssues: FLAKY_ISSUE,
      passesOnRerun: true,
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(true);
    expect(result.status).toBe(0);
  });

  it("re-runs a job GitHub cancelled, though the Quality check that needs it failed, and merges when the re-run passes", () => {
    const result = gate({ bucket: "cancel", log: "", flakyIssues: "", passesOnRerun: true });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(true);
  });

  it("re-runs a Quality check GitHub cancelled while every job it needs passed, and merges when the re-run passes", () => {
    const result = gate({
      bucket: "cancel",
      log: "",
      flakyIssues: "",
      passesOnRerun: true,
      qualityAlone: true,
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(true);
  });

  it("does not re-run a job that failed in a test no open flaky-test issue names, and does not merge", () => {
    const log = FLAKY_LOG.replace("e2e/gateway-fast-fail.test.ts", "e2e/doctor-drift.test.ts");
    const result = gate({ bucket: "fail", log, flakyIssues: FLAKY_ISSUE, passesOnRerun: true });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
    expect(result.output).toContain("not merged: CI not green");
  });

  it("does not re-run a failed job whose log names no failed test, and does not merge", () => {
    const log =
      "E2E (2/3)\tE2E tests\t2026-10-06T10:00:00Z  error TS2322: Type 'string' is not assignable\n";
    const result = gate({ bucket: "fail", log, flakyIssues: FLAKY_ISSUE, passesOnRerun: true });
    expect(result.reruns).toBe(0);
    expect(result.merged).toBe(false);
  });

  it("re-runs only once: a known flaky failure that fails again is not merged", () => {
    const result = gate({
      bucket: "fail",
      log: FLAKY_LOG,
      flakyIssues: FLAKY_ISSUE,
      passesOnRerun: false,
    });
    expect(result.reruns).toBe(1);
    expect(result.merged).toBe(false);
    expect(result.status).toBe(1);
  });
});

function stackGate(ci: Record<number, "pass" | "fail">) {
  const dir = mkdtempSync(join(tmpdir(), "merge-pr-stack-"));
  writeFileSync(join(dir, "body"), VALID_BODY);
  const stack = JSON.stringify([
    { open: false, pull_requests: [{ number: 3, state: "closed" }] },
    {
      open: true,
      pull_requests: [11, 12, 13].map((number) => ({ number, state: "open" })),
    },
  ]);
  writeFileSync(join(dir, "stack.json"), stack);
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
d=${JSON.stringify(dir)}
echo "$*" >>"$d/calls"
case "$*" in
  "repo view --json nameWithOwner"*) echo o/r ;;
  "api repos/o/r/stacks?pull_request=12 -q "*) shift 3; jq -r "$1" "$d/stack.json" ;;
  "pr view "*" --json state"*) echo OPEN ;;
  "pr view "*" --json isDraft"*) echo false ;;
  "pr view "*" --json labels"*) ;;
  "pr view "*" --json body"*) cat "$d/body" ;;
  "pr view "*" --json headRefName"*) echo task/x ;;
  "pr view "*" --json mergeable"*) echo MERGEABLE ;;
${Object.entries(ci)
  .map(([pr, bucket]) => `  "pr checks ${pr} --json name,bucket"*) echo "${bucket} Quality" ;;`)
  .join("\n")}
  "pr checks "*" --json bucket,link"*) echo "fail https://github.com/o/r/actions/runs/77/job/5" ;;
  "issue list --label flaky-test"*) ;;
  "run view 77 --log-failed") echo "error TS2322" ;;
  "stack merge 12 --yes --squash") touch "$d/merged" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  let status = 0;
  let output = "";
  try {
    output = execFileSync("sh", [SCRIPT, "12"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MERGE_PR_POLL_SECONDS: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    status = failed.status;
    output = failed.stdout + failed.stderr;
  }
  const calls = readFileSync(join(dir, "calls"), "utf8");
  return {
    status,
    output,
    gated: [...calls.matchAll(/^pr checks (\d+) --json name,bucket/gm)].map((m) => Number(m[1])),
    merged: existsSync(join(dir, "merged")),
  };
}

describe("merge-pr.sh on a stacked PR", () => {
  it("gates every PR from the bottom of the stack up to the one asked for, then merges them with gh stack merge", () => {
    const result = stackGate({ 11: "pass", 12: "pass", 13: "fail" });

    expect(result.gated).toEqual([11, 12]);
    expect(result.merged).toBe(true);
    expect(result.output).toContain("merged #11 #12");
  });

  it("merges nothing when a PR below the one asked for fails a gate", () => {
    const result = stackGate({ 11: "fail", 12: "pass", 13: "pass" });

    expect(result.status).toBe(1);
    expect(result.merged).toBe(false);
    expect(result.output).toContain("CI not green on PR #11");
  });
});
