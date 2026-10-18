import type { z } from "zod";

import { requestedClass, waitingRequestSchema } from "../../contract/index.js";
import { connectDaemonClient } from "../connect.js";
import { commandArgs, UsageError, writeResult } from "../args.js";
import type { CommandContext } from "../tree.js";

type WaitingRequestEntry = z.infer<typeof waitingRequestSchema>;

async function run(
  argv: readonly string[],
  { environment, token }: CommandContext,
): Promise<number> {
  const values = commandArgs(argv, {
    devices: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    leases: { type: "boolean" },
    requests: { type: "boolean" },
    rules: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write("Usage: simlock list [--devices|--leases|--rules|--requests]\n");
    return 0;
  }
  if ([values.devices, values.leases, values.rules, values.requests].filter(Boolean).length > 1)
    throw new UsageError("list accepts only one of --devices, --leases, --rules, or --requests");
  const client = await connectDaemonClient(environment, token);
  try {
    if (values.requests) {
      const requests = waitingRequestSchema.array().parse(await client.list({ kind: "requests" }));
      environment.stdout.write(`${formatWaitingRequests(requests, environment.clock.now())}\n`);
      return 0;
    }
    const kind = values.leases ? "leases" : values.rules ? "rules" : "devices";
    writeResult((value) => environment.stdout.write(value), await client.list({ kind }));
    return 0;
  } finally {
    await client.close();
  }
}

type WaitingReasonWord = NonNullable<WaitingRequestEntry["reason"]>;

const WAITING_REASON_TEXT: Readonly<Record<WaitingReasonWord, (platform: string) => string>> = {
  "behind-earlier-request": () => "Behind an earlier request",
  "device-limit": () => "Full: device limit",
  "global-running-limit": () => "Full: running limit",
  "no-free-physical": () => "Every matching device is leased or absent",
  "platform-running-limit": (platform) =>
    `Full: running limit for ${platform === "ios" ? "iOS" : "Android"}`,
  "ram-budget": () => "Full: RAM budget",
  "waiting-for-device": () => "A matching device is starting",
};

function waitingReasonText(request: WaitingRequestEntry): string | undefined {
  if (request.reason === undefined) return undefined;
  const text = WAITING_REASON_TEXT[request.reason](request.spec.platform);
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

function formatWaitingRequests(requests: readonly WaitingRequestEntry[], now: number): string {
  if (requests.length === 0) return "No requests are waiting.";
  return requests
    .map((request) => {
      const { spec } = request;
      const device = [
        spec.platform,
        spec.physical === true ? "physical" : undefined,
        spec.model ?? `class ${String(requestedClass(spec))}`,
        spec.osVersion,
        spec.mode === undefined ? undefined : `mode ${spec.mode}`,
        spec.imageTag === undefined ? undefined : `image tag ${spec.imageTag}`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
      const where = request.workerId === undefined ? "" : ` on ${request.workerId}`;
      const stage =
        request.queuePosition === undefined
          ? request.stage
          : `${request.stage} at ${String(request.queuePosition)}`;
      const waited = Math.max(0, Math.round((now - request.createdAt) / 1000));
      const why = waitingReasonText(request);
      return `Request ${request.id}: ${request.requesterId}${where}, ${device}, ${stage}, waiting ${String(waited)}s${why === undefined ? "" : ` — ${why}`}`;
    })
    .join("\n");
}

export { run };
