#!/usr/bin/env node
// SubagentStop hook: a delivery stage agent may not stop before its last message is its report
// block. The block's first key names the agent:
//
//   implementer         issue: <N> ...
//   reviewer            PR: #<M>  Round: ...
//   hardware-verifier   PR: #<M>  Hardware: ...
//
// An implementer's `mode: audit` report must also hold its `audit:` line: an audit given fixes
// as well once did the fixes and skipped the audit. Other agents stop freely. Claude Code ends
// the turn anyway after eight blocks in a row.
import fs from "node:fs";

const REPORT = {
  implementer: /^issue: \d+/m,
  reviewer: /^PR: #\d+\s+Round:/m,
  "hardware-verifier": /^PR: #\d+\s+Hardware:/m,
};

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const shape = REPORT[input.agent_type];
const message = input.last_assistant_message ?? "";
if (shape === undefined) process.exit(0);

if (!shape.test(message)) {
  block(
    "You stopped without your report block. If a helper agent or a command you started is " +
      "still running, wait for it in the foreground. Then finish the work and end with the " +
      "report block your instructions define, and nothing after it.",
  );
} else if (/\bmode: audit\b/.test(message) && !/^audit: /m.test(message)) {
  block(
    "Your report is an audit's but has no `audit:` line, so the audit did not run. Do the " +
      "audit in implement-audit.md on the whole diff, then report again with its `audit:` line.",
  );
}

function block(reason) {
  console.log(JSON.stringify({ decision: "block", reason }));
}
