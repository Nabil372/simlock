import type { Paging } from "../../ds";
import type { ConsoleRange } from "../../state/range";
import type { UsageState } from "../../state/usage";

export function UsageBody(_props: {
  readonly state: UsageState;
  readonly range: ConsoleRange;
  readonly onRange: (range: ConsoleRange) => void;
  readonly paging: { readonly workers: Paging; readonly requesters: Paging };
}) {
  return null;
}
