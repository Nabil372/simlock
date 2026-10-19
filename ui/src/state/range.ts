export type { ConsoleRange } from "../model/range";
import type { ConsoleRange } from "../model/range";

export function useRange(): readonly [ConsoleRange, (range: ConsoleRange) => void] {
  return ["1h", () => undefined];
}
