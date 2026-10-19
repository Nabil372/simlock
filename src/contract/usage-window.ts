export interface UsageWindowAsk {
  readonly since?: string;
  readonly from?: string;
  readonly to?: string;
}

export type UsageWindowRefusal =
  | { readonly parameter: "from"; readonly problem: "since-and-from" }
  | { readonly parameter: "to"; readonly problem: "to-without-from" }
  | { readonly parameter: "from"; readonly problem: "not-before-to" }
  | { readonly parameter: "since"; readonly problem: "bad-duration"; readonly value: string }
  | {
      readonly parameter: "from" | "to";
      readonly problem: "bad-time";
      readonly value: string;
    };

export type UsageWindowAnswer =
  | { readonly window: { readonly from: number; readonly to: number } }
  | { readonly refused: UsageWindowRefusal };

export function usageWindow(_ask: UsageWindowAsk, _now: number): UsageWindowAnswer {
  throw new Error("usageWindow is not implemented");
}
