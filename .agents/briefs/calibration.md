# Findings rejected in the 4 weeks to 2026-10-13

Each line below was raised as blocking and rejected when it was verified against the code,
with the reason after the dash. A finding like one of these is right only with evidence that
distinguishes it from the rejected one: name the input or state that makes this one differ.

Written by `node .agents/scripts/delivery-stats.mjs --calibration`; 470 rejected findings in all.

## spec review

- #496 src/core/doctor.test.ts:463 optionalModules order unproven — duplicate of the code finding, fixed there
- #495 supervisor.test.ts:1099 "removes the record" unproven — duplicate of the code finding, fixed there
- #495 supervisor.ts:248 start-failed remedy points to an empty log — duplicate of the code finding at :244, fixed there
- #463 src/gateway/fleet-coordinator.ts:1093 assumption contradicts spec "That code does not change" — not blocking: Done when 8 needs the change; one extra dispatch, never a wrong device
- #463 src/core/physical-presence.ts:15 memory survives device remove — not blocking: recorded Assumption, self-heals within one probe interval
- #461 src/drivers/ios/physical.ts:77 ECID matching needs `context.source`, missing before Node 22 — not blocking: package.json engines require node >=22
- #458 src/core/doctor.ts:240 stalled-transition-detected moved before the fix — detection before its effect; no doc states the old order; a spec test needs it
- #458 src/contract/schemas.test.ts:609 title claims the worker view — it parses devices with the same schema; worker-view.test.ts:64 proves it

## code review

- #495 supervisor.test.ts:1099 deleting removeRecord stays green — duplicate of the spec finding, fixed
- #495 supervisor.ts:745 stop-waiter removal untested — the leak is not observable without asserting private state
- #494 participants called inside decisions.run (lease-release-coordinator.ts:173) — duplicate of the spec finding, fixed there
- #468 src/leasing/create-leasing.test.ts:3959 (also :4009, fleet-coordinator.test.ts:4837) fail only by a 5 s timeout without the waiting-request check — they still fail, because the second request is never refused.
- #463 src/core/physical-presence.ts:23 last finished read wins over a newer one — not blocking: transient, self-heals at next watcher read, no wrong device
- #461 src/drivers/ios/physical.ts:390 timed-out read deletes its file right after SIGTERM — not blocking: a stray temp file, no wrong state or rule breach
- #461 src/drivers/ios/index.ts:1555 simctl on an Android physical lease names `devicectl` — not blocking: Android inspectPhysical refuses every device, so no such lease exists
- #458 src/leasing/physical-device-watcher.ts:202 a grant does not reset the miss count — the spec names the resets; a grant is not one

## claims review

- #468 src/leasing/lease-acquisition-coordinator.ts:299 cites ADR 0023, not in docs/internal/adr/ — ADR 0023 is accepted on draft PR #465, merged by the maintainer.
- #468 docs/EVENTS.md:26 "one-lease-per-requester" wording is stale — the default limit is still 1; the name is dated, not false.
- #468 src/leasing/lease-acquisition-coordinator.ts:322 "one-lease-per-requester check" is stale — it still describes the default limit.
- #462 src/daemon/dispatcher.ts:135 execEnv doc says driver keys are "layered on top"; unsetEnv now removes keys — not blocking: still true of the layering; unsetEnv is documented at the use site
- #458 src/leasing/lease-release-coordinator.ts:86 set doc omits return reclaims — incomplete, not false; deleted under rule 17
- #458 src/contract/schemas.ts:204, src/core/doctor.ts:257, src/core/registry.ts:123 — each gives a why
- #458 src/daemon/server.test.ts:2032, :3087, src/leasing/lease-release-coordinator.ts:165, :274 — each gives a why (round 2)
- #456 src/gateway/queue.ts:15 `FleetLeaseRecord` doc points at another module — the maintainer accepted it as reviewed
