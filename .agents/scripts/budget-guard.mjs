#!/usr/bin/env node
// PreToolUse hook: stops a sub-agent, or a whole session, that has used too much.
//
// Usage is read from the session's transcripts: <session>.jsonl plus
// <session>/subagents/*.jsonl. It is counted in "input-token equivalents",
// weighted roughly by price: input 1, cache write 1.25, cache read 0.1, output 5.
//
//   agent limit → a sub-agent past its own limit gets every tool call blocked except
//                 `git add|commit|push` and `gh issue|pr comment`, so it can save its work
//                 and report; the rest of the session runs on.
//   soft limit  → every tool call is blocked except `gh issue|pr comment`,
//                 so the agent can post its handoff and stop.
//   hard limit  → (soft × 1.2, or run time past the limit + 30 min) the whole
//                 session process group is killed.
//
// Run time counts only active time: a gap of more than 30 minutes between two tool calls (a
// session waiting overnight for a person) is not counted.
//
// Limits come from the environment (set them in settings.local.json "env"):
//   CLAUDE_BUDGET_AGENT_TOKENS  default 15000000   (0 disables the agent limit)
//   CLAUDE_BUDGET_TOKENS  default 120000000   (0 disables the token limit)
//   CLAUDE_BUDGET_HOURS   default 10          (0 disables the time limit)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const LIMIT_AGENT_TOKENS = Number(process.env.CLAUDE_BUDGET_AGENT_TOKENS ?? 15_000_000);
const LIMIT_TOKENS = Number(process.env.CLAUDE_BUDGET_TOKENS ?? 120_000_000);
const LIMIT_HOURS = Number(process.env.CLAUDE_BUDGET_HOURS ?? 10);
const HARD_FACTOR = 1.2;
const HARD_GRACE_MS = 30 * 60 * 1000;
const IDLE_GAP_MS = 30 * 60 * 1000;
const WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (!input.transcript_path || !input.session_id) process.exit(0);

// A subagent's transcript lives in <session>/subagents/; climb back to the session.
let main = input.transcript_path;
if (path.basename(path.dirname(main)) === "subagents") {
  main = path.dirname(path.dirname(main)) + ".jsonl";
}
const sessionDir = main.replace(/\.jsonl$/, "");
const subDir = path.join(sessionDir, "subagents");
const files = [main];
try {
  for (const f of fs.readdirSync(subDir))
    if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
} catch {}

// Incremental state so each call reads only what was appended since the last one.
const stateFile = path.join(os.tmpdir(), `claude-budget-${input.session_id}.json`);
let state = { activeMs: 0, lastSeen: null, files: {} };
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {}

for (const file of files) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    continue;
  }
  const s = (state.files[file] ??= { offset: 0, lastId: null, total: 0 });
  if (st.size < s.offset) Object.assign(s, { offset: 0, lastId: null, total: 0 });
  if (st.size === s.offset) continue;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(st.size - s.offset);
  fs.readSync(fd, buf, 0, buf.length, s.offset);
  fs.closeSync(fd);
  const text = buf.toString("utf8");
  const end = text.lastIndexOf("\n") + 1; // leave a half-written line for next time
  for (const line of text.slice(0, end).split("\n")) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const u = rec.message?.usage;
    const id = rec.message?.id;
    // One API message is written as several lines with the same id; count it once.
    if (!u || !id || id === s.lastId) continue;
    s.lastId = id;
    s.total +=
      (u.input_tokens ?? 0) * WEIGHTS.input +
      (u.cache_creation_input_tokens ?? 0) * WEIGHTS.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * WEIGHTS.cacheRead +
      (u.output_tokens ?? 0) * WEIGHTS.output;
  }
  s.offset += Buffer.byteLength(text.slice(0, end));
}
const now = Date.now();
const gap = typeof state.lastSeen === "number" ? now - state.lastSeen : 0;
if (gap > 0 && gap <= IDLE_GAP_MS) state.activeMs = (state.activeMs ?? 0) + gap;
state.lastSeen = now;
fs.writeFileSync(stateFile, JSON.stringify(state));

const used = Object.values(state.files).reduce((a, s) => a + s.total, 0);
const elapsedMs = state.activeMs ?? 0;
const limitMs = LIMIT_HOURS * 3600 * 1000;
const overTokens = LIMIT_TOKENS > 0 && used >= LIMIT_TOKENS;
const overTime = LIMIT_HOURS > 0 && elapsedMs >= limitMs;
const fmt = (n) => `${(n / 1e6).toFixed(1)}M`;
const cmd = input.tool_input?.command ?? "";

if (!overTokens && !overTime) {
  // Inside a sub-agent, transcript_path can be the session's own; agent_id names the sub-agent.
  const agentFile =
    typeof input.agent_id === "string"
      ? path.join(subDir, `agent-${input.agent_id.replace(/^agent-/, "")}.jsonl`)
      : input.transcript_path !== main
        ? input.transcript_path
        : null;
  const agentUsed = agentFile === null ? 0 : (state.files[agentFile]?.total ?? 0);
  if (LIMIT_AGENT_TOKENS <= 0 || agentUsed < LIMIT_AGENT_TOKENS) process.exit(0);
  const saving = /^\s*(?:cd \S+ && )?(?:git (?:add|commit|push)|gh (?:issue|pr) comment)\b/;
  if (input.tool_name === "Bash" && saving.test(cmd)) process.exit(0);
  process.stderr.write(
    `Budget limit reached: this agent used ${fmt(agentUsed)} of its ${fmt(LIMIT_AGENT_TOKENS)} ` +
      `budget tokens. Stop now. Commit and push what you have (git add, commit and push are ` +
      `still allowed), then end with your report block, with "budget" under open.\n`,
  );
  process.exit(2);
}

const why = overTokens
  ? `used ${fmt(used)} of ${fmt(LIMIT_TOKENS)} budget tokens`
  : `ran ${(elapsedMs / 3600000).toFixed(1)}h of ${LIMIT_HOURS}h active`;

const hard =
  (LIMIT_TOKENS > 0 && used >= LIMIT_TOKENS * HARD_FACTOR) ||
  (LIMIT_HOURS > 0 && elapsedMs >= limitMs + HARD_GRACE_MS);
if (hard) {
  process.stderr.write(`budget-guard: hard limit hit (${why}); killing session.\n`);
  try {
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(process.ppid)])
      .toString()
      .trim();
    if (pgid) process.kill(-Number(pgid), "SIGTERM");
  } catch {}
  process.kill(process.ppid, "SIGTERM");
  process.exit(2);
}

// Soft limit: let the agent post its handoff, block everything else.
if (input.tool_name === "Bash" && /^\s*gh (issue|pr) comment\b/.test(cmd)) process.exit(0);
process.stderr.write(
  `Budget limit reached: this session ${why}. Stop now. ` +
    `Post a "## Handoff" comment on each issue you were working on (gh issue comment / gh pr comment ` +
    `are still allowed) saying where you stopped, then end your turn. Do not start new work.\n`,
);
process.exit(2);
