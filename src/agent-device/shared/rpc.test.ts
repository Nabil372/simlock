import { describe, expect, it } from "vitest";

import { commandLeaseId } from "./rpc.js";

const first = "a".repeat(32);
const second = "b".repeat(32);

describe("a command's lease ID", () => {
  it("is read from params.meta.leaseId, else params.flags.leaseId, and a value that is not 32 lowercase hex is no lease ID", () => {
    expect(commandLeaseId({ meta: { leaseId: first } })).toBe(first);
    expect(commandLeaseId({ flags: { leaseId: second } })).toBe(second);
    expect(commandLeaseId({ flags: { leaseId: second }, meta: { leaseId: first } })).toBe(first);

    expect(commandLeaseId({ meta: { leaseId: first.toUpperCase() } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: first.slice(1) } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: `${first}0` } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: `${"g".repeat(32)}` } })).toBeUndefined();
    expect(commandLeaseId({ meta: { leaseId: 7 } })).toBeUndefined();
    expect(commandLeaseId({})).toBeUndefined();
  });
});
