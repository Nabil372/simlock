import type { UsageOutput } from "../../../src/contract/index";

export interface StatsShape {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  readonly granted?: number;
  readonly waitP95?: number | null;
  readonly partial?: boolean;
  readonly coversFrom?: number;
  readonly series?: readonly {
    readonly at: number;
    readonly leasesHeld: number | null;
    readonly queueDepth: number | null;
    readonly slotsUsed: number | null;
  }[];
}

// why: a stats answer carries many figures the console never reads; a test names only the ones the
// console shows, and the rest stay out of the way.
export function statsOf(shape: StatsShape): UsageOutput {
  return {
    bucketMs: shape.bucketMs,
    coversFrom: shape.coversFrom ?? shape.from,
    partial: shape.partial ?? false,
    series: (shape.series ?? []).map((point) => ({
      ...point,
      slotsMax: null,
      waiting: null,
    })),
    totals: {
      granted: shape.granted ?? 0,
      wait: { count: 0, max: null, p50: null, p95: shape.waitP95 ?? null },
    },
    window: { from: shape.from, to: shape.to },
  } as unknown as UsageOutput;
}
