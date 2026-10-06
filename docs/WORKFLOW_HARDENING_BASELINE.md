# Workflow hardening: Phase 1 baseline

Date: 2026-10-06.
Scope: test repairs, incident fixtures, validation evidence and pending-work inventory.
No application workflow, business rule, schema or live record was changed in this phase.

## Revision and scope

Committed reference: d6e65add6115ecd34b285df20f66e2f51ceb7f2c.
This is a dirty-worktree baseline, not a new commit or a deployed revision. Prior
fixes and concurrent user edits remain in place. No files were staged or reverted.
The reference hash alone does not identify those uncommitted changes.

Phase 1 files:

- src/services/agent/agent.service.test.ts: controlled Date clock for availability holds.
- src/services/agent/agent.service.regressions.test.ts: static extractor calls and
  controlled clocks for the three extraction regressions.
- src/services/agent/workflow-baseline.fixtures.json: four incident fixtures with
  thirteen customer turns, observed replies and required outcomes.
- src/services/agent/agent.conversation-replay.test.ts: fixture integrity coverage
  and three explicitly pending workflow gates.
- docs/WORKFLOW_HARDENING_BASELINE.md: this gate and scope record.

## Repairs

The extractor changed from an instance method to BookingExtractor.regexExtract().
Three tests retained the old call. They now use the public static API rather than
casting the instance or changing production code to satisfy old tests.

The availability-hold test asserts a 13:00 slot on 6 October 2026. Production
availability correctly filters past times, so that assertion failed later in the
same day. Its test clock now starts at 06:00 UTC (09:00 Nairobi) on that date.
The extraction tests use the same controlled clock. Node's context.mock.timers
provides per-test clock control and cleanup; real application time is unchanged.
This is targeted clock repair, not a certification that every older test is
independent of wall-clock time.

## Frozen incidents

1. Paid Muse session -> Power Suit -> completion question -> invoice request.
2. Saved-add-on status and durable customer-name recall.
3. Initial reschedule request referring to an unavailable Friday.
4. Blocked reschedule -> clarification -> date-only availability -> 1oam typo ->
   valid date/time -> unintended package collection.

The fixtures preserve customer wording, including typos. Quote punctuation is
normalized to ASCII; a shortened catalog reply is explicitly labeled an excerpt.
Synthetic customer/booking identifiers replace real identifiers. The stored name
is a synthetic seed, not a live profile claim. The conflicting draft is explicitly
a hypothesis fixture; its live contents have not been inspected.

The new fixture-integrity test checks data and transcript preservation. It does
not claim to execute every frozen incident against corrected application behavior.
Existing behavior regressions remain alongside it in the repository.

## Gate evidence

| Check | Result |
| --- | --- |
| Four previously failing targeted checks | 4 passed, 0 failed |
| Full backend suite, first completed run | 477 passed, 0 failed |
| Full backend suite, sequential repeat | 477 passed, 0 failed |
| Final replay | 16 passed, 0 failed, 3 todo; exit 0 |
| Final fixture integrity check | 1 passed, 0 failed |
| TypeScript | npx tsc --noEmit -p .; exit 0 |

Validation temporarily set DATABASE_URL to an unreachable local endpoint and
restored it afterward. Relevant storage, Calendar and provider boundaries use
the existing mocks. No real customer integration, live cleanup or migration was
performed. Imports initializing configured services are not live-integration proof.
Interrupted terminal results were not counted; final totals came from completed
sequential commands with explicit exit codes.

## Pending workflow gates

These are test.todo entries, not passing behavior assertions:

- A blocked reschedule stays blocked through clarification; the model cannot resume it.
- Date-only availability is queried for the existing booking before asking for a time.
- Time typos and provider outages preserve the stored operation and selected date.

Replace each todo with a runnable state/behavior assertion during workflow hardening.
The suite's exit 0 is a Phase 1 baseline gate, not customer-workflow or release approval.

## Proposed review and commit boundaries

| Group | Existing surfaces | Gate before committing |
| --- | --- | --- |
| Startup/schema readiness | src/config/schema-readiness.ts and related pending startup fixes | Verify current scope and retain operator migration restrictions |
| Identity and extraction | extraction.ts, slot-memory.ts, booking-tools.ts and related regressions | Review concurrent edits and distinguish source fixes from Phase 1 test repairs |
| Confirmed-session, invoice and account replies | agent.service.ts, appointment-replies.ts, invoice-tools.ts, routes.ts and regressions | Isolate hunks from reschedule and emoji changes |
| Reschedule entry and booking binding | conversation-flow.matcher.ts, agent.service.ts, routes.ts, booking-tools.ts, reschedule-flow.test.ts | Review exact workflow scope and unresolved conflict recovery |
| Emoji policy | emoji-policy.ts, constants.ts, formatter/verifier/matcher changes and EMOJI_POLICY_REVIEW.md | Client whitelist/copy approval and separate commit |
| Phase 1 baseline | The Phase 1 files listed above | Explicit commit approval; isolate shared-file test hunks |

These are proposed review boundaries, not claims that commits have been created.
Several files contain multiple groups. Do not stage whole mixed files or remove
other work to manufacture a clean commit. No prior commit hold or copy approval
is silently released by this baseline phase.

## Next approval gate

Phase 2 defines the workflow contract: authoritative facts, active-operation states,
allowed transitions, blocked-state recovery, expiry, confirmation and side-effect
boundaries. It should consume these fixtures and pending gates. Storage design,
migrations, live stale-draft inspection/cleanup and deployment remain separately
approved operations. Phase 1 stops here; it does not redesign the dispatcher.

The proposed Phase 2 contract is now in [WORKFLOW_CONTRACT.md](WORKFLOW_CONTRACT.md).
Its D01-D08 decisions, transition tables and AC01-AC20 criteria await review; writing
that document does not resolve the three pending replay gates or approve a migration.