import type { UsageOutput } from "../../../src/contract/index";
import { type FiguresState, figuresOf } from "../model/figures";
import { type ConsoleRange, statsPath } from "../model/range";
export type { FigureChart, FiguresState } from "../model/figures";
import { useLiveResource, useNow } from "./live";
import { loadView } from "./resource";

// why: the stats are their own read, not joined with the fleet's: a refused read hides only the
// figures it feeds.
export function useFigures(range: ConsoleRange): FiguresState {
  const view = loadView(useLiveResource<UsageOutput>(statsPath(range)));
  const now = useNow();
  if (view.kind === "loading") return view;
  if (view.kind === "unsupported") {
    return { kind: "refused", message: "Not available on a single host." };
  }
  if (view.kind === "refused") return view;
  const data = figuresOf(view.data, range, now.server);
  return view.refusal === undefined
    ? { data, kind: "ready" }
    : { data, kind: "ready", refusal: view.refusal };
}
