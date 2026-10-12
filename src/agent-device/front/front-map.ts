import type { TokenIdentity } from "../../http/token-store.js";
import type { Clock } from "../../ports/index.js";

export interface FrontMapEntry {
  readonly identity: TokenIdentity;
  readonly address: string;
  readonly ttlMs: number;
  readonly deadline: number;
}

export interface ListedLease {
  readonly id: string;
  readonly ttlDeadline: number;
}

export class FrontMap {
  constructor(readonly clock: Clock) {}

  add(_leaseId: string, _entry: FrontMapEntry): void {}

  get(_leaseId: string): (FrontMapEntry & { readonly endedAt?: number }) | undefined {
    return undefined;
  }

  markEnded(_leaseId: string): void {}

  async refresh(
    _list: (identity: TokenIdentity) => Promise<readonly ListedLease[]>,
  ): Promise<void> {}
}
