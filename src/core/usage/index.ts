import type { UsageOutput } from "../../contract/index.js";

export interface UsageGetInput {
  readonly from: number;
  readonly to: number;
}

export type UsageResult =
  | { readonly kind: "figures"; readonly usage: UsageOutput }
  | { readonly kind: "not-kept"; readonly oldestTs: number }
  | { readonly kind: "unavailable" };

export interface UsageReaderDeps {
  readonly historyPath: string;
  opened(): boolean;
  tokenLabels(): Promise<ReadonlyMap<string, string>>;
  workers(): readonly { readonly id: string; readonly label?: string | undefined }[];
  readonly fleet?: { readonly requesterPrefix: string };
}

export interface UsageReader {
  get(input: UsageGetInput): Promise<UsageResult>;
  stop(): Promise<void>;
}

export function createUsageReader(_deps: UsageReaderDeps): UsageReader {
  return {
    get: () => Promise.resolve({ kind: "unavailable" }),
    stop: () => Promise.resolve(),
  };
}
