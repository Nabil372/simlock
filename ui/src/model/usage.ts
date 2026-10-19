import type { UsageOutput } from "../../../src/contract/index";
import type { FigureTile } from "./figures";
import type { ConsoleRange } from "./range";

export interface UsageCount {
  readonly label: string;
  readonly count: string;
}

export interface UsageDuration {
  readonly name: string;
  readonly count: string;
  readonly p50: string;
  readonly p95: string;
  readonly max: string;
}

export interface UsageLine {
  readonly label: string;
  readonly text: string;
}

export interface UsageScopeRow {
  readonly key: string;
  readonly name: string;
  readonly requests: string;
  readonly granted: string;
  readonly rejected: string;
  readonly waitP95: string;
}

export interface UsageRequesterRow {
  readonly key: string;
  readonly id: string;
  readonly label?: string;
  readonly requests: string;
  readonly granted: string;
  readonly rejected: string;
  readonly held: string;
}

export interface UsageView {
  readonly note?: string;
  readonly tiles: readonly FigureTile[];
  readonly bySource: readonly UsageCount[];
  readonly durations: readonly UsageDuration[];
  readonly rejections: readonly UsageCount[];
  readonly incidents: readonly UsageCount[];
  readonly use: readonly UsageLine[];
  readonly platforms: readonly UsageScopeRow[];
  readonly workers: readonly UsageScopeRow[];
  readonly requesters: readonly UsageRequesterRow[];
}

export type UsageState =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "ready"; readonly data: UsageView; readonly refusal?: string };

export function usageOf(_stats: UsageOutput, _range: ConsoleRange, _now: number): UsageView {
  return {
    bySource: [],
    durations: [],
    incidents: [],
    platforms: [],
    rejections: [],
    requesters: [],
    tiles: [],
    use: [],
    workers: [],
  };
}

export function usageRangeSearch(search: string, _range: ConsoleRange): string {
  return search;
}
