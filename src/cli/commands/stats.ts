import { usageWindow, type UsageWindowRefusal } from "../../contract/index.js";
import { commandArgs, UsageError, writeResult } from "../args.js";
import { connectDaemonClient } from "../connect.js";
import { formatUsage } from "../stats.js";
import type { CommandContext } from "../tree.js";

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    from: { type: "string" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    since: { type: "string" },
    to: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(
      "Usage: simlock stats [--since <duration> | --from <ISO> [--to <ISO>]] [--json]\n",
    );
    return 0;
  }
  const asked = usageWindow(
    {
      ...(typeof values.from === "string" ? { from: values.from } : {}),
      ...(typeof values.since === "string" ? { since: values.since } : {}),
      ...(typeof values.to === "string" ? { to: values.to } : {}),
    },
    environment.clock.now(),
  );
  if ("refused" in asked) throw new UsageError(statsRefusal(asked.refused));
  const client = await connectDaemonClient(environment, token);
  try {
    const usage = await client.usage(asked.window);
    if (values.json) writeResult((value) => environment.stdout.write(value), usage);
    else environment.stdout.write(`${formatUsage(usage)}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

function statsRefusal(refusal: UsageWindowRefusal): string {
  switch (refusal.problem) {
    case "since-and-from":
      return "stats takes --since or --from, not both";
    case "to-without-from":
      return "--to needs --from";
    case "not-before-to":
      return "--from must be earlier than --to, or than now when --to is left out";
    case "bad-duration":
      return `Invalid duration: ${refusal.value}`;
    case "bad-time":
      return `Invalid time: ${refusal.value} (use ISO 8601 with Z or an offset)`;
  }
}

export { run };
