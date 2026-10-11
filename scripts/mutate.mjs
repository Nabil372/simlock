#!/usr/bin/env node
// `pnpm mutate [base]`: mutation-test only the source lines this branch changed against base
// (default origin/main), with the unit suite, and print each mutant the suite let live.
// Results are kept per branch in the clone's git directory, shared by its worktrees: a run reuses
// every mutant whose code and covering tests did not change, and a run with nothing changed
// under src/ or ui/src/ since the branch's last run reprints that run's result.
//
// A survivor is a line you can change, or delete, with a green suite: testing rules 2 and 3.
// Exit 0 when every mutant died, 1 when any survived or had no covering test, 2 when Stryker
// failed without a report.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const REPORT = ".stryker-tmp/report/mutation.json";
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const base = process.argv[2] ?? "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const mergeBase = git("merge-base", base, "HEAD").trim();
const diff = git(
  "diff",
  "-U0",
  "--no-color",
  mergeBase,
  "--",
  "src/*.ts",
  "ui/src/*.ts",
  "ui/src/*.tsx",
  ":!*.test.ts",
  ":!*.test.tsx",
);

const ranges = [];
let file = null;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) file = line === "+++ /dev/null" ? null : line.slice(6);
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (file !== null && hunk !== null) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.push(`${file}:${start}-${start + count - 1}`);
  }
}

if (ranges.length === 0) {
  console.log(`No changed source lines under src/ or ui/src/ since ${base}; nothing to mutate.`);
  process.exit(0);
}

const cache = join(git("rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "mutate");
mkdirSync(cache, { recursive: true });
for (const name of readdirSync(cache)) {
  if (Date.now() - statSync(join(cache, name)).mtimeMs > KEEP_MS) rmSync(join(cache, name));
}
// Keyed by the branch's first commit, not its name: fix runs push the branch from local
// branches of other names.
const branch = join(
  cache,
  git("rev-list", "--reverse", "--first-parent", `${mergeBase}..HEAD`).split("\n")[0],
);
const sources = git("ls-tree", "HEAD", "--", "src", "ui/src");
const clean = git("status", "--porcelain", "--", "src", "ui/src").trim() === "";
const last = existsSync(`${branch}.last.json`)
  ? JSON.parse(readFileSync(`${branch}.last.json`, "utf8"))
  : null;

if (clean && last?.sources === sources) {
  console.log(
    `Nothing under src/ or ui/src/ changed since this branch's last run; its result stands.`,
  );
  print(last.total, ranges.length, last.alive);
}

// A killed run leaves its sandboxes behind; start clean.
rmSync(".stryker-tmp", { force: true, recursive: true });
const run = spawnSync(
  "pnpm",
  [
    "exec",
    "stryker",
    "run",
    "--mutate",
    ranges.join(","),
    "--incremental",
    "--incrementalFile",
    `${branch}.json`,
  ],
  { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
process.stderr.write(run.stderr ?? "");
if (!existsSync(REPORT)) {
  // Last, so a caller that keeps only the tail of the output still sees why.
  const tail = (run.stderr ?? "").trimEnd().split("\n").slice(-15).join("\n");
  console.error(`\nStryker exited ${run.status} without a report: no mutant was tested.\n${tail}`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const alive = [];
let total = 0;
for (const [path, { mutants }] of Object.entries(report.files)) {
  for (const m of mutants) {
    total += 1;
    if (m.status === "Survived" || m.status === "NoCoverage") {
      const replacement = (m.replacement ?? "").replace(/\s+/g, " ").slice(0, 80);
      alive.push(`${path}:${m.location.start.line} ${m.status} ${m.mutatorName}: ${replacement}`);
    }
  }
}
if (clean) writeFileSync(`${branch}.last.json`, JSON.stringify({ sources, total, alive }));
print(total, ranges.length, alive);

function print(total, rangeCount, alive) {
  console.log(`\n${total} mutants on ${rangeCount} changed ranges; ${alive.length} alive.`);
  for (const line of alive) console.log(line);
  if (alive.length > 0) console.log("Kill each one, or explain it in the PR body.");
  process.exit(alive.length === 0 ? 0 : 1);
}
