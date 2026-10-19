import type { UsageFigures, UsageOutput } from "../../contract/index.js";
import type { DeviceFactRow, MinuteBucket, RequestRow } from "../../history/index.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BUCKET_WIDTHS_MS = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR];
const MAX_SERIES_POINTS = 200;

export function usageBucket(from: number, to: number): { bucketMs: number; from: number } {
  const floored = (width: number) => Math.floor(from / width) * width;
  const fits = (width: number) => Math.ceil((to - floored(width)) / width) <= MAX_SERIES_POINTS;
  const bucketMs = BUCKET_WIDTHS_MS.find(fits) ?? (BUCKET_WIDTHS_MS.at(-1) as number);
  return { bucketMs, from: floored(bucketMs) };
}

export interface UsageData {
  readonly window: { readonly from: number; readonly to: number };
  readonly bucketMs: number;
  readonly fleet: boolean;
  readonly oldestTs: number | undefined;
  readonly requestRows: readonly RequestRow[];
  readonly deviceFacts: readonly DeviceFactRow[];
  minutes(workerId: string, platform: string): readonly MinuteBucket[];
  readonly workers: readonly { readonly id: string; readonly label?: string | undefined }[];
}

type Platform = "ios" | "android";

interface Scope {
  readonly platform?: Platform;
  readonly worker?: string;
}

type Samples = UsageFigures["wait"];

export function computeUsage(data: UsageData): UsageOutput {
  const { window } = data;
  const minutes = memoMinutes(data);
  const totalsWorker = data.fleet ? "*" : "";
  const figures = (scope: Scope) => figuresFor(data, minutes, scope);
  const coversFrom =
    data.oldestTs === undefined ? window.from : Math.max(window.from, data.oldestTs);
  return {
    bucketMs: data.bucketMs,
    coversFrom,
    partial: coversFrom > window.from,
    platforms: { android: figures({ platform: "android" }), ios: figures({ platform: "ios" }) },
    requesters: requestersOf(data),
    series: seriesOf(data, minutes(totalsWorker, "all")),
    totals: figures({}),
    window: { from: window.from, to: window.to },
    workers: workerIds(data).map(({ id, label }) => ({
      ...figures({ worker: id }),
      id,
      ...(label === undefined ? {} : { label }),
    })),
  };
}

function memoMinutes(data: UsageData) {
  const memo = new Map<string, readonly MinuteBucket[]>();
  return (workerId: string, platform: string): readonly MinuteBucket[] => {
    const key = `${workerId}\u0000${platform}`;
    let found = memo.get(key);
    if (found === undefined) {
      found = data.minutes(workerId, platform);
      memo.set(key, found);
    }
    return found;
  };
}

function workerIds(
  data: UsageData,
): { readonly id: string; readonly label?: string | undefined }[] {
  if (!data.fleet) return [data.workers[0] ?? { id: "local" }];
  const labels = new Map(data.workers.map((worker) => [worker.id, worker.label]));
  const named = [...data.requestRows, ...data.deviceFacts].flatMap((row) =>
    row.workerId === undefined || row.workerId === "" ? [] : [row.workerId],
  );
  return [...new Set([...labels.keys(), ...named])]
    .sort()
    .map((id) => ({ id, label: labels.get(id) }));
}

function inScope(
  data: UsageData,
  row: { readonly platform?: string | undefined; readonly workerId?: string | undefined },
  scope: Scope,
): boolean {
  if (scope.platform !== undefined && row.platform !== scope.platform) return false;
  return scope.worker === undefined || !data.fleet || row.workerId === scope.worker;
}

const isRequest = (row: RequestRow): boolean => !row.probe && row.refusedAtAdmission !== true;

function figuresFor(
  data: UsageData,
  minutes: (workerId: string, platform: string) => readonly MinuteBucket[],
  scope: Scope,
): UsageFigures {
  const to = data.window.to;
  const rows = data.requestRows.filter((row) => inScope(data, row, scope));
  const facts = data.deviceFacts.filter((fact) => inScope(data, fact, scope));
  const grants = rows.filter((row) => row.grantedAt !== undefined && row.grantedAt <= to);
  const waits = rows.flatMap((row) => (isRequest(row) ? waitOf(row, to) : []));
  const rejections = rows.filter(
    (row) => !row.probe && row.rejectedAt !== undefined && row.rejectedAt <= to,
  );
  const sources = countBy(grants.map((row) => row.source ?? "unknown"));
  const factsOf = (kind: string) => facts.filter((fact) => fact.kind === kind);
  const durations = (kind: string) =>
    summarise(factsOf(kind).flatMap((fact) => fact.durationMs ?? []));
  const count = (...kinds: string[]) => kinds.reduce((sum, kind) => sum + factsOf(kind).length, 0);
  const failed = count("device.recovery-failed");
  const worker = scope.worker === undefined ? undefined : data.fleet ? scope.worker : "";
  const buckets = minutes(worker ?? (data.fleet ? "*" : ""), scope.platform ?? "all");
  return {
    boot: durations("device.ready"),
    bySource: {
      booted: sources.booted ?? 0,
      provisioned: sources.provisioned ?? 0,
      ...(data.fleet ? { unknown: unknownSources(sources) } : {}),
      warm: sources.warm ?? 0,
    },
    declined: count("lease.declined"),
    failures: { byEvent: failed === 0 ? {} : { "device.recovery-failed": failed } },
    granted: grants.length,
    held: summarise(grants.flatMap((row) => heldOf(row, to))),
    incidents: {
      crashRecovered: count("device.recovered"),
      lost: count(
        "device.recovery-failed",
        "device.quarantine-abandoned",
        "device.quarantine-stranded",
      ),
      quarantineRecovered: count("device.quarantine-recovered"),
      quarantined: count("device.quarantined"),
    },
    ...(data.fleet ? {} : { probes: rows.filter((row) => row.probe).length }),
    provisioning: durations("device.provisioned"),
    queue: scope.platform === undefined ? queueOf(buckets) : { meanDepth: null, peakDepth: null },
    rejected: {
      byReason: countBy(rejections.map((row) => row.reason ?? "unknown")),
      total: rejections.length,
    },
    requests: rows.filter(isRequest).length,
    turnaround: summarise(
      grants.flatMap((row) => {
        const [wait] = isRequest(row) ? waitOf(row, to) : [];
        const [held] = heldOf(row, to);
        return wait === undefined || held === undefined ? [] : [wait + held];
      }),
    ),
    utilisation: utilisationOf(buckets, scope.platform === undefined),
    wait: summarise(waits),
  };
}

const unknownSources = (counts: Readonly<Record<string, number>>): number =>
  Object.entries(counts).reduce(
    (sum, [source, count]) =>
      source === "warm" || source === "booted" || source === "provisioned" ? sum : sum + count,
    0,
  );

function waitOf(row: RequestRow, to: number): number[] {
  if (row.grantedAt !== undefined && row.grantedAt <= to) return [row.grantedAt - row.requestedAt];
  if (row.rejectedAt !== undefined && row.rejectedAt <= to) {
    return [row.rejectedAt - row.requestedAt];
  }
  return [];
}

function heldOf(row: RequestRow, to: number): number[] {
  return row.heldMs !== undefined && row.endedAt !== undefined && row.endedAt <= to
    ? [row.heldMs]
    : [];
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function summarise(values: readonly number[]): Samples {
  if (values.length === 0) return { count: 0, max: null, p50: null, p95: null };
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (share: number) =>
    sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] as number;
  return { count: sorted.length, max: sorted.at(-1) as number, p50: rank(0.5), p95: rank(0.95) };
}

type Field = keyof Omit<MinuteBucket, "start" | "knownMs">;

function fieldOf(
  buckets: readonly MinuteBucket[],
  field: Field,
): { readonly peak: number; readonly mean: number } | undefined {
  let peak: number | undefined;
  let integral = 0;
  let knownMs = 0;
  for (const bucket of buckets) {
    const figure = bucket[field];
    if (figure === undefined) continue;
    peak = peak === undefined ? figure.peak : Math.max(peak, figure.peak);
    integral += figure.integral;
    knownMs += bucket.knownMs;
  }
  return peak === undefined ? undefined : { mean: knownMs === 0 ? peak : integral / knownMs, peak };
}

function queueOf(buckets: readonly MinuteBucket[]): UsageFigures["queue"] {
  const depth = fieldOf(buckets, "queueDepth");
  return { meanDepth: depth?.mean ?? null, peakDepth: depth?.peak ?? null };
}

function utilisationOf(
  buckets: readonly MinuteBucket[],
  withRam: boolean,
): UsageFigures["utilisation"] {
  const slots = fieldOf(buckets, "slotsUsed");
  const ram = withRam ? fieldOf(buckets, "ramUsedBytes") : undefined;
  return {
    ...(ram === undefined
      ? {}
      : {
          ram: {
            limitBytes: fieldOf(buckets, "ramLimitBytes")?.peak ?? 0,
            meanBytes: ram.mean,
            peakBytes: ram.peak,
          },
        }),
    slots: {
      max: fieldOf(buckets, "slotsMax")?.peak ?? null,
      mean: slots?.mean ?? null,
      peak: slots?.peak ?? null,
    },
  };
}

function seriesOf(data: UsageData, buckets: readonly MinuteBucket[]): UsageOutput["series"] {
  const { from, to } = data.window;
  const byStart = new Map(buckets.map((bucket) => [bucket.start, bucket]));
  const points = Math.ceil((to - from) / data.bucketMs);
  return Array.from({ length: points }, (_, index) => {
    const bucket = byStart.get(from + index * data.bucketMs);
    const peak = (field: Field) => bucket?.[field]?.peak ?? null;
    const ram = bucket?.ramUsedBytes?.peak;
    return {
      at: Math.min(from + (index + 1) * data.bucketMs, to),
      leasesHeld: peak("leasesHeld"),
      queueDepth: peak("queueDepth"),
      ...(ram === undefined ? {} : { ramUsedBytes: ram }),
      slotsMax: peak("slotsMax"),
      slotsUsed: peak("slotsUsed"),
      waiting: peak("waiting"),
    };
  });
}

type Requester = UsageOutput["requesters"][number];

function requestersOf(data: UsageData): Requester[] {
  const to = data.window.to;
  const byId = new Map<string, Requester>();
  for (const row of data.requestRows) {
    const granted = row.grantedAt !== undefined && row.grantedAt <= to;
    if (row.probe && !granted) continue;
    const entry = byId.get(row.requester) ?? {
      granted: 0,
      heldTotalMs: 0,
      id: row.requester,
      rejected: 0,
      requests: 0,
    };
    byId.set(row.requester, {
      ...entry,
      granted: entry.granted + Number(granted),
      heldTotalMs: entry.heldTotalMs + (granted ? (heldOf(row, to)[0] ?? 0) : 0),
      rejected:
        entry.rejected + Number(!row.probe && row.rejectedAt !== undefined && row.rejectedAt <= to),
      requests: entry.requests + Number(isRequest(row)),
    });
  }
  return [...byId.values()].sort(
    (left, right) => right.requests - left.requests || (left.id < right.id ? -1 : 1),
  );
}
