import type { UsageOutput } from "../../../src/contract/index";
import { dayWord } from "./event-list";
import { extremes, minuteLabel } from "./history";
import { formatCount } from "./paging";
import { type ConsoleRange, rangeUnit } from "./range";
import { formatDuration } from "./time";

export interface FigureTile {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
}

export interface ChartPoint {
  readonly at: number;
  readonly label: string;
  readonly count: number | null;
}

export interface FigureChart {
  readonly key: "leasesHeld" | "queueDepth" | "slotsUsed";
  readonly title: string;
  readonly unit: string;
  readonly heading: string;
  readonly bucketMs: number;
  readonly points: readonly ChartPoint[];
  readonly summary: string;
}

export type FiguresState =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly data: Figures; readonly refusal?: string };

export interface Figures {
  readonly note?: string;
  readonly granted: FigureTile;
  readonly wait: FigureTile;
  readonly charts: readonly FigureChart[];
}

const DAY = 86_400_000;

// why: under a second a duration would round to `0 s`, which says "no wait" for a wait that was
// real.
export function formatWait(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1_000 ? `${Math.round(ms)} ms` : formatDuration(ms);
}

// why: the Overview and the Waiting page show the same tile from the same answer, so it is built
// once.
export function waitTile(stats: UsageOutput, range: ConsoleRange): FigureTile {
  return {
    label: "Wait p95",
    unit: rangeUnit(range),
    value: formatWait(stats.totals.wait.p95),
  };
}

const CHARTS: readonly {
  readonly key: FigureChart["key"];
  readonly title: string;
  readonly heading: string;
}[] = [
  { heading: "Leases held", key: "leasesHeld", title: "Leases held" },
  { heading: "Requests in the queue", key: "queueDepth", title: "Requests in the queue" },
  { heading: "Device slots in use", key: "slotsUsed", title: "Device slots in use" },
];

function chartOf(
  stats: UsageOutput,
  spec: (typeof CHARTS)[number],
  unit: string,
  now: number,
): FigureChart {
  const { bucketMs, window } = stats;
  const withDay = window.to - window.from > DAY;
  const points = stats.series.map((point, index): ChartPoint => {
    const start = window.from + index * bucketMs;
    const label = minuteLabel(start);
    return {
      at: point.at,
      count: point[spec.key],
      label: withDay ? `${dayWord(start, now)} ${label}` : label,
    };
  });
  const range = extremes(points);
  const current = points.at(-1);
  const summary =
    range === undefined || current === undefined
      ? ""
      : `Now ${current.count ?? "—"}; highest ${range.highest.count} at ${range.highest.label}; lowest ${range.lowest.count} at ${range.lowest.label}.`;
  return {
    bucketMs,
    heading: spec.heading,
    key: spec.key,
    points,
    summary,
    title: `${spec.title}, ${unit}`,
    unit,
  };
}

export function figuresOf(stats: UsageOutput, range: ConsoleRange, now: number): Figures {
  const unit = rangeUnit(range);
  const covers = stats.coversFrom;
  return {
    charts: CHARTS.map((spec) => chartOf(stats, spec, unit, now)),
    granted: { label: "Granted", unit, value: formatCount(stats.totals.granted) },
    wait: waitTile(stats, range),
    ...(stats.partial
      ? { note: `Figures cover from ${dayWord(covers, now)} ${minuteLabel(covers)}.` }
      : {}),
  };
}
