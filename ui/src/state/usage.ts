import type { UsageOutput } from "../../../src/contract/index";
import type { Paging } from "../ds";
import { TABLE_SIZES } from "../model/paging";
import type { ConsoleRange } from "../model/range";
import { statsPath } from "../model/range";
import { type UsageState, usageOf, usageRangeSearch } from "../model/usage";
import { useLiveResource, useNow } from "./live";
import { usePaging } from "./paging";
import { loadView } from "./resource";
import { setSearch, useSearch } from "./router";
import { readRange } from "../model/range";

export type {
  UsageCount,
  UsageDuration,
  UsageLine,
  UsageRequesterRow,
  UsageScopeRow,
  UsageState,
  UsageView,
} from "../model/usage";

// why: the stats are one read for the whole page, like the Overview's, so with both on screen there
// is one resource and one request in flight.
export function useUsage(range: ConsoleRange): UsageState {
  const view = loadView(useLiveResource<UsageOutput>(statsPath(range)));
  const now = useNow();
  if (view.kind === "loading") return view;
  if (view.kind === "unsupported") {
    return { kind: "refused", message: "Not available on a single host." };
  }
  if (view.kind === "refused") return view;
  const data = usageOf(view.data, range, now.server);
  return view.refusal === undefined
    ? { data, kind: "ready" }
    : { data, kind: "ready", refusal: view.refusal };
}

export function useUsageRange(): readonly [ConsoleRange, (range: ConsoleRange) => void] {
  const search = useSearch();
  return [
    readRange(search),
    (range) => setSearch(usageRangeSearch(window.location.search, range), { replace: true }),
  ];
}

export function useUsagePaging(state: UsageState): {
  readonly workers: Paging;
  readonly requesters: Paging;
} {
  const ready = state.kind === "ready" ? state.data : undefined;
  return {
    requesters: usePaging({
      name: "requesters",
      sizes: TABLE_SIZES,
      total: ready?.requesters.length,
    }),
    workers: usePaging({ name: "workers", sizes: TABLE_SIZES, total: ready?.workers.length }),
  };
}

// why: the short tables show every row, so their pager never shows.
export function wholePage(total: number): Paging {
  return {
    go: () => undefined,
    last: 1,
    page: 1,
    range: `1–${total} of ${total}`,
    resize: () => undefined,
    size: Math.max(total, 1),
    sizes: [Math.max(total, 1)],
    total,
  };
}
