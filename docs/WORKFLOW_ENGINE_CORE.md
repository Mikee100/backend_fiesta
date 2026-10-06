# Workflow hardening: Phase 3 decision core

Date: 2026-10-06. Status: pure core implemented and tested; runtime integration pending.
D01-D08 approval covers the behavioral contract, not database or deployment changes.

## Implemented scope

src/services/agent/workflow-engine.ts contains decideWorkflow(snapshot, event, origin).
It imports only the existing pure booking-policy helper. It does not load Prisma,
environment settings, providers, Calendar or messaging services, read the clock itself,
or mutate input records. The caller supplies authoritative time and verified state.

The core returns planned transitions, code-owned template keys, missing fields,
command descriptors and expected operation identity/revision. It executes no effects.
The dispatcher must supply trusted event origin outside model tool arguments; origin
is not an authentication mechanism that an untrusted caller may self-assert.

Covered decisions:

- Retain an explicit block across clarification, suggested slots, consent attempts
  and reconstructed snapshots; information reads cannot clear it.
- Plan a separate block referencing a competing operation without replacing that
  operation or reusing BookingDraft.version as payment-attempt accounting.
- Bind reschedules/cancellations to customer-owned, future confirmed bookings;
  ambiguous or foreign targets cannot produce action commands.
- Collect new-booking fields without borrowing the existing session's date/time;
  account holder and session recipient remain distinct.
- Query date-only availability before asking for time; validate result identity,
  operation revision, edition, date and excluded booking. A failed read is not a
  fully booked result.
- Accept customer-origin values only. Model/reference/rejected values cannot become
  operation slots. Input intent and field-role validation belong to a future adapter.
- Record a time-clarification candidate for 1oam, retaining selected date, including
  a date in that same turn. A clarification yes can request availability but cannot
  charge, reschedule or cancel.
- Require a delivered prior-turn proposal, matching target, revision, slots and
  action kind before planning a mutating command. Recheck deposit and policy facts.
- Retain pending/unknown effects for reconciliation; never use expiry to erase them.
- Produce deterministic idempotency keys and revision preconditions for action
  commands. Actual at-most-once execution requires the future persistence/executor.
- Preserve optional-extra decision and recipient prerequisites before new-booking
  proposals. Selected extras without a validated storage result fail closed.

Existing 72-hour policy functions are reused, including the exact equality boundary.
No new expiry duration, deposit amount, refund rule or customer-facing copy was set.

## Tests and evidence

src/services/agent/workflow-engine.test.ts is included in the canonical npm test script.
Twenty pure checks cover blocked-state preservation, scoped reads, failed state loads,
ownership, unresolved effects, date/time collection, availability, typo clarification,
delivery evidence, separate consent, stale versions, expired state, event origin,
policy/deposit changes, recipient separation and the frozen blocked incident.

Test restart coverage serializes/reconstructs logical snapshots. It does not read
PostgreSQL after a process restart. The frozen incident test maps observed turns to
validated events; it does not certify natural-language intent classification.

Validation results:

- Pure engine: 20 passed, zero failed; no application integrations imported.
- Final canonical backend suite: 497 passed, zero failed; exit 0.
- Existing replay: 16 passed, zero failed, three todo; exit 0.
- Final TypeScript and editor diagnostics: clean.

Configured database access was redirected to an unreachable local endpoint for the
application test gates. The pure tests require no database or provider. No production
record inspection, mutation, payment, Calendar operation or outbound message occurred.

## Not enabled or implemented

The live handleMessage dispatcher does not call this core yet. Existing WhatsApp
behavior therefore does not acquire these guarantees by importing the tests.
No schema migration, storage adapter, snapshot loader, command executor, delivery
evidence recorder, callback journal, blocked-request storage or staff-resolution
event was implemented. No process-local replacement is presented as durable storage.

Add-on mutation and validated selected-extra persistence, payment callback/retry
execution, downstream Calendar/invoice reconciliation and full workflow rendering
remain later workflow-migration work. Unsupported transitions fail closed; the core
is not a complete replacement for all legacy handlers.

The three replay todos remain intentionally pending until real dispatcher and
persisted-state tests establish the corresponding behavior. They were not relabeled
passing merely because related pure rules now have unit coverage.

## Integration prerequisites

1. Review physical storage for operation state, blocked-request context, clarification,
   accepted fields, revisions and delivered proposal evidence. Preserve payment-attempt
   accounting and existing confirmed-booking/payment/invoice records.
2. Approve isolated database, migration baseline and rollback before schema work.
3. Implement a verified snapshot/input adapter. It must validate customer ownership,
   identity provenance, booking date/time consistency, field roles, action consent,
   proposal expiry and trusted system results before calling the pure core.
4. Persist planned transitions with revision/ownership checks and delivery evidence;
   do not ask a customer for consent to an unrecorded or undelivered proposal.
5. Implement idempotent command/result processing, including effect uncertainty and
   projection failures. A returned command is not evidence it ran successfully.
6. Migrate one dispatcher workflow at a time and execute full persisted-state incident
   replays, duplicates/concurrency cases, provider failures and restart tests.

No live stale draft is automatically deleted. No handoff ownership, copy approval,
commit hold or deployment gate is silently released by this implementation.

The proposed storage and rollout design is in
[WORKFLOW_STORAGE_DESIGN.md](WORKFLOW_STORAGE_DESIGN.md). Its P01-P06 choices and
isolated-database gates require review before schema/adaptor implementation.