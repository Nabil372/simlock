import type { UsageOutput } from "../../../src/contract/index";
import type { ConsoleRange } from "./range";

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

export function formatWait(_ms: number | null): string {
  return "";
}

export function waitTile(_stats: UsageOutput, _range: ConsoleRange): FigureTile {
  return { label: "Wait p95", unit: "", value: "" };
}

export function figuresOf(_stats: UsageOutput, _range: ConsoleRange, _now: number): Figures {
  return {
    charts: [],
    granted: { label: "Granted", unit: "", value: "" },
    wait: { label: "Wait p95", unit: "", value: "" },
  };
}
