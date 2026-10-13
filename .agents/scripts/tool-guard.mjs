#!/usr/bin/env node
// PreToolUse hook (Bash, Agent): refuses two tool calls the delivery rules forbid.
//
//   check      a sub-agent runs a check from toolchain.md's "Checks agents never run" (`pnpm
//              check`, `pnpm fallow`, ...) or a tool behind one, from any path. The commit hook,
//              the push hook and CI run them. The main session (a person, a routine) may.
//   isolation  an `implementer`, `reviewer` or `hardware-verifier` is started with `isolation`.
//              Every stage of a task works in the task's one worktree, one after another.
//
// A refusal exits 2 with the reason on stderr, which the agent reads.
import fs from "node:fs";
import path from "node:path";

const SCRIPTS = new Set([
  "check",
  "test",
  "typecheck",
  "typecheck:e2e",
  "lint",
  "lint:comments",
  "format",
  "format:check",
  "fallow",
  "mutate",
]);
const TOOLS = new Set(["tsc", "oxlint", "oxfmt", "fallow", "stryker"]);
const NODE_SCRIPTS = new Set(["comment-lint.mjs", "mutate.mjs"]);
const WRAPPERS = new Set(["time", "nice", "env", "command", "exec"]);
const STAGES = new Set(["implementer", "reviewer", "hardware-verifier"]);

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const tool = input.tool_name;
const args = input.tool_input ?? {};

if ((tool === "Agent" || tool === "Task") && args.isolation && STAGES.has(args.subagent_type)) {
  refuse(
    `Refused: a ${args.subagent_type} takes no \`isolation\`. Every stage of a task works in ` +
      "the task's one worktree (`.agents/scripts/worktree.sh <branch>`), one stage after " +
      "another. Start the agent again without `isolation`.",
  );
}

if (tool === "Bash" && typeof input.agent_id === "string") {
  const found = forbiddenCheck(args.command ?? "");
  if (found !== null) {
    refuse(
      `Refused: \`${found}\` is under "Checks agents never run" in toolchain.md. The commit ` +
        "hook runs lint, the comment lint and typecheck; the push hook runs Fallow and the e2e " +
        "typecheck; CI runs the rest. Their errors show in the commit or push output. Run only " +
        'the commands under "Tests agents run".',
    );
  }
}
process.exit(0);

function refuse(reason) {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function forbiddenCheck(command) {
  // why: a heredoc body is data (a script fed to python or cat), not commands the shell runs.
  const shell = command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, "$3");
  for (const segment of shell.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    while (words.length > 0 && (/^\w+=/.test(words[0]) || WRAPPERS.has(words[0]))) words.shift();
    if (words[0] === "timeout") words.splice(0, 2);
    if (words.length > 0 && isForbidden(words)) return segment.trim().replace(/\s*\d?>+$/, "");
  }
  return null;
}

function isForbidden(words) {
  const [first, ...rest] = words;
  const name = path.basename(first);
  if (TOOLS.has(name) || NODE_SCRIPTS.has(name)) return true;
  if (name === "node") return rest.some((w) => NODE_SCRIPTS.has(path.basename(w)));
  if (name === "npx" || name === "bunx") return TOOLS.has(path.basename(firstOperand(rest) ?? ""));
  if (name !== "pnpm") return false;

  const operands = rest.filter((w) => !w.startsWith("-"));
  let [sub, ...after] = operands;
  if (sub === "exec" || sub === "dlx") return TOOLS.has(path.basename(after[0] ?? ""));
  if (sub === "run") [sub, ...after] = after;
  if (SCRIPTS.has(sub)) return true;
  // why: these scripts are allowed only in their narrow forms: named e2e files, Chromium only.
  if (sub === "test:e2e") return after.length === 0;
  if (sub === "test:console") return !rest.includes("--project=chromium");
  return false;
}

function firstOperand(words) {
  return words.find((w) => !w.startsWith("-"));
}

function unquote(word) {
  return word.replace(/^['"]|['"]$/g, "");
}
