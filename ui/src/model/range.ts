export type ConsoleRange = "1h" | "6h" | "24h" | "7d";

export const RANGE_CHOICES: readonly { readonly value: ConsoleRange; readonly label: string }[] = [
  { label: "1 hour", value: "1h" },
  { label: "6 hours", value: "6h" },
  { label: "24 hours", value: "24h" },
  { label: "7 days", value: "7d" },
];

export function readRange(_search: string): ConsoleRange {
  return "1h";
}

export function writeRange(search: string, _range: ConsoleRange): string {
  return search;
}

export function statsPath(_range: ConsoleRange): string {
  return "/v1/stats";
}

export function rangeUnit(_range: ConsoleRange): string {
  return "last hour";
}
