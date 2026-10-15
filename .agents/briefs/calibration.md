# Findings rejected in the 4 weeks to 2026-10-15

Each line below was raised as blocking and rejected when it was verified against the code,
with the reason after the dash. A finding like one of these is right only with evidence that
distinguishes it from the rejected one: name the input or state that makes this one differ.

Written by `node .agents/scripts/delivery-stats.mjs --calibration`; 498 rejected findings in all.

## spec review

- #565 the same test written twice at host-load.test.ts:671 and :753 — breaks no behaviour
- #561 src/http/server.ts:554 wrapping every gateway response is blocking — not blocking: only affects bodies already failing mid-stream
- #524 docs/CLIENT.md:186 CAPABILITY_MISSING claim for the last capable worker going — the same defect as the claims finding, fixed there as text
- #509 `e2e/slow-agent-device.test.ts` short sample gap stays green — not blocking: Assumption 1 accepts it
- #382 the title "within the configured grace" promises more than the < 3 s bound proves — not blocking: the likely regression (the option ignored, so the 10 s default applies) fails the < 3 s assertion by name; only a grace between 0.1 s and 2.8 s gets through
- #497 edge.test.ts:493 "no idempotency key" unproven — unobservable at the daemon seam (Assumption 2)
- #497 allocate.ts:77 unknown target silently ignored — decided by Assumption 5
- #497 host.ts:42 randomUUID bypasses the IdGenerator port — no rule requires it; Assumption 4

## code review

- #567 the gateway copies the worker's probe-default decision (main.ts:845) — the shared factory is used and behaviour is the same
- #565 duplicate of a spec finding on optional `nowMicros`, kept once
- #562 src/link/link-channels.test.ts:687 fails only by 5 s timeout when waiters never drain — not blocking: named test still goes red for the right reason
- #562 src/link/link-channels.test.ts:779 bare `await next` fails only by timeout — not blocking: same
- #562 src/link/link-channels.test.ts:732 rejects-with-closed fails only by timeout — not blocking: same
- #562 src/link/link-channels.test.ts:719 signal-reason fails only by timeout — not blocking: same
- #562 src/link/link-channels.test.ts:183 not-accepted fails only by timeout — not blocking: same
- #562 src/link/link-messages.test.ts:100 closeWith fails only by timeout — not blocking: same

## claims review

- #568 docs/CONSOLE.md:152 page description omits the Load panel — incomplete wording, no wrong state
- #509 `toolchain.md` package.json names only a short hash — not blocking: still true via vendor/README.md
- #468 src/leasing/lease-acquisition-coordinator.ts:299 cites ADR 0023, not in docs/internal/adr/ — ADR 0023 is accepted on draft PR #465, merged by the maintainer.
- #468 docs/EVENTS.md:26 "one-lease-per-requester" wording is stale — the default limit is still 1; the name is dated, not false.
- #468 src/leasing/lease-acquisition-coordinator.ts:322 "one-lease-per-requester check" is stale — it still describes the default limit.
- #462 src/daemon/dispatcher.ts:135 execEnv doc says driver keys are "layered on top"; unsetEnv now removes keys — not blocking: still true of the layering; unsetEnv is documented at the use site
- #458 src/leasing/lease-release-coordinator.ts:86 set doc omits return reclaims — incomplete, not false; deleted under rule 17
- #458 src/contract/schemas.ts:204, src/core/doctor.ts:257, src/core/registry.ts:123 — each gives a why
