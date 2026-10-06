# Workflow hardening: Phase 4 storage and rollout design

Status: PROPOSED - technically reviewed; execution and outstanding decisions await approval.
Date: 2026-10-06.
This is a design, not an applied migration. No Prisma schema, database, customer
record, payment, Calendar event, runtime routing or deployment is changed here.

## 1. Recommendation and constraints

Use six additive workflow tables for aggregate ownership, operation state, blocked
requests, events, evidence and commands. Keep confirmed business records in their
existing tables. Do not turn CustomerMemory.keyInsights into a financial workflow
store, and do not remove BookingDraft's one-customer uniqueness to bypass a conflict.

Observed local constraints:

- BookingDraft is unique by customerId and currently serves multiple operation kinds.
- Payment has a unique optional bookingDraftId and an optional bookingId.
- payment-recovery.ts derives attempts from BookingDraft.version - 1. New workflow
  revisions must be separate; do not increment that counter for conversational turns.
- Message.externalId is unique, but content/history does not store scoped proposal
  consent or guarantee provider delivery.
- Prisma uses PostgreSQL and String/cuid identifiers. Existing timestamps are not
  consistently PostgreSQL timezone-aware types; this design makes no conversion of
  existing business columns.
- prisma.config.ts names prisma/migrations, but no migration files were found in
  this workspace. The deployed schema/migration ledger have not been inspected.
- The Phase 3 core has no live snapshot adapter, persistence or command execution.

The first integration should be rescheduling an unambiguous paid, confirmed booking,
with no unresolved payment effect and no unverified legacy conflict. Other operations
stay on their existing path until individually migrated and tested.

## 2. Proposed storage entities

Names are proposals; field lists describe the review contract, not ready-to-run DDL.
Use TEXT identifiers compatible with existing Prisma String IDs. Use TIMESTAMPTZ
for new absolute instants; represent accepted business dates/times as validated
YYYY-MM-DD and HH:mm values with the existing Africa/Nairobi interpretation.
Use TEXT plus explicit CHECK constraints for finite kinds/states, rather than an
unconstrained string or assuming a PostgreSQL enum rollback is trivial.

### S01. workflow_sessions: per-customer aggregate and writer ownership

| Field | Purpose |
| --- | --- |
| customerId, primary key/FK | One aggregate per existing customer |
| routingOwner | legacy or workflow_reschedule_v1; defaults to legacy |
| ownershipEpoch | Fencing generation, incremented only on an approved ownership transfer |
| revision | Aggregate concurrency token independent of payment attempt counts |
| activeOperationId, nullable | Pointer to the owned nonterminal operation |
| blockedRequestId, nullable | Pointer to the active block/queued request context |
| schemaVersion, createdAt, updatedAt | Adapter compatibility and audit; not business expiry clocks |

The customer-scoped pointer FKs must reference children of the same customer.
Create child rows then update pointers in the same transaction. A session with a
broken pointer, unknown owner or unsupported schemaVersion is inconsistent, not idle.

### S02. workflow_operations: accepted operation state

| Field | Purpose |
| --- | --- |
| id, customerId | Opaque operation identity and account ownership |
| kind, state, revision, schemaVersion | Validated engine operation and its independent version |
| targetBookingId, nullable | Existing booking binding; absent for a separate new booking |
| acceptedSlots JSONB | Typed name/recipientName/service/date/time values accepted by the engine |
| slotEvidence JSONB | Field source, inbound event/message identity and acceptance revision |
| sameDayOnly, forSomeoneElse, addonsDecided | Explicit customer intent/prerequisites, not transcript inference |
| expiresAt, nullable | Reviewed operation-specific deadline, not arbitrary updatedAt age |
| sourceLegacyDraftId, nullable | Optional audited provenance; never permission to overwrite that draft |
| startedEventId, terminalEventId, terminalAt | Lifecycle/audit evidence |

Only this operation's accepted slots feed new proposals. Rejected/reference dates
may be recorded as non-actionable event context but must not enter acceptedSlots.
Profile identity remains on Customer; accepting a recipient does not update it.

Add a partial unique index on customerId for nonterminal states. Terminal states
are completed, withdrawn and expired. Payment-open, applying and reconciling remain
nonterminal even after a deadline until their external effects are accounted for.
At most one nonterminal operation is allowed; blocks are separate and do not count
as permission to start a second mutating operation.

### S03. workflow_blocks: blocked requests without replacing the competing state

| Field | Purpose |
| --- | --- |
| id, customerId, revision, schemaVersion | Scoped identity/version |
| intendedKind, desiredTargetBookingId, nullable | What the customer requested, not an accepted active operation |
| conflictingOperationId OR conflictingLegacyDraftId | Exactly one identified conflict reference |
| reasonCode, status | open, review_requested or resolved; code-owned reason |
| nonActionableContext JSONB | Desired date/time, provenance and clarification needs while blocked |
| createdEventId, resolvedEventId, resolvedAt | Auditable creation and verified resolution |
| reviewReference, nullable | Existing escalation/handoff linkage, without inventing staff acknowledgement |

Use a CHECK for exactly one non-null conflict-reference field, plus FKs. A block
references the real legacy draft or workflow operation, not a fabricated new row
made from guessed transcript contents. Payment uncertainty remains a reconciliation
condition; do not manufacture an operation conflict if the actual issue is unknown IO.

A partial unique index allows one unresolved block per customer for this initial
design. A second different request while blocked cannot replace the first silently:
retain the current block and ask which request to address, or request team review.

Clearing a block requires an authenticated, customer-scoped resolution event and
verified competing-state/effect checks. "I don't understand", a model response,
expiry guessed from chat or an availability question never resolves it.

### S04. workflow_events: input, decision and result journal

| Field | Purpose |
| --- | --- |
| id, customerId, eventKey | Stable scoped event identity and deduplication key |
| origin, eventType, channel | Trusted customer/system/operator origin; not model arguments |
| operationId, blockId, commandId, nullable | Links to the exact event scope |
| messageId, parentEventId, nullable | Normalized inbound-member claim and same-customer batch parent |
| inputSchemaVersion, normalizedInput JSONB | Bounded validated input; proposals from a model remain untrusted data |
| decisionId, decision JSONB, beforeRevision, afterRevision | Accepted decision and transition audit |
| status, recordedAt, decidedAt, appliedAt | received, decided, applied, rejected or reconciliation_pending |
| messageReferences JSONB | Ordered existing Message IDs making up a debounced turn |

Unique(customerId, eventKey) prevents duplicate inbound/callback decision application.
The ingress adapter derives the key from verified provider/event identity, not message
text. A debounced turn uses stable ordered member identities and per-message claims;
the same message cannot be processed in two overlapping batches. A provider result
gets a separate system-event identity, not the customer's confirmation turn ID.

messageReferences JSONB is an audit/display list, not a deduplication constraint.
Represent each claimed inbound member as an eventType=inbound_member child row in
this same table. Use UNIQUE(customerId, messageId) for non-null messageId and scoped
FKs to Message(customerId, id) and the parent workflow event. Create the customer-turn
row and all member claims atomically; any overlapping claim aborts that batch and
forces recomputation against the already claimed members. CHECKs tie messageId and
parentEventId to the member event type. The adapter verifies inbound direction,
account and channel under the transaction. Only the parent turn enters the engine.
This avoids adding a seventh table while making membership enforcement relational.

Reuse existing Message content rather than copying full transcripts/secrets into
journal payloads. Authenticated callbacks must be associated with their stored
attempt/command; customerId supplied by a payload is not ownership proof.

### S05. workflow_evidence: immutable proposals and clarifications

| Field | Purpose |
| --- | --- |
| id, customerId, operationId, operationRevision | Exact operation/version binding |
| evidenceKind, actionKind, schemaVersion | proposal or time_clarification; distinct consent purpose |
| targetBookingId, nullable; acceptedValues JSONB | Exact presented target/slots/candidate, not mutable operation state |
| amount, catalogProof, policyProof, nullable | Validated money/policy facts with their source/version |
| presentedEventId, outboundMessageId, providerMessageId | Durable turn/message identity |
| renderedTextHash | Binds the recorded evidence to the exact rendered proposal |
| presentationState, acceptedAt, deliveredAt, shownAt, expiresAt | Explicit lifecycle and reviewed deadline |
| supersededByEvidenceId, consentEventId, consumedAt | Old proposals cannot authorize a corrected action |

Unique(operationId, operationRevision, evidenceKind) prevents competing evidence for
one decision. Proposal/candidate values are immutable after presentation. Corrections
create a new revision/evidence row; do not overwrite the old proposed date/amount.

Default presentationState is pending. Provider API acceptance, provider delivery,
customer read and a web-rendered response are different facts. This design recommends
mapping the engine's delivered=true only from verified delivered/shown evidence.
Acceptance alone remains insufficient under that strict rule. See P03 before enabling
it: provider delivery event handling and the behavior of an early customer yes must
be verified so a delayed webhook does not silently trigger or lose consent.

For an early yes with insufficient delivery evidence, retain it as an unconsumed
input and explain the pending verification. Do not silently apply it later when a
delivery webhook arrives; require an eligible later customer confirmation after
the proposal is demonstrably presented. Any alternative boundary needs explicit
contract approval, not an adapter casually setting delivered=true after send().

### S06. workflow_commands: transactional outbox and effect results

| Field | Purpose |
| --- | --- |
| id, customerId, operationId nullable, evidenceId nullable, decidedEventId | Exact command provenance; scoped reads/artifacts need not invent an operation |
| commandKind, effectKind, payloadSchemaVersion, payload JSONB | Immutable validated action/read/delivery input |
| idempotencyKey, decisionExpectedRevision, executionRevision, ownershipEpoch, bookingFingerprint | Decision CAS, committed execution state, owner fence and target preconditions |
| status, leaseToken, leaseUntil, attempts, nextAttemptAt | ready, running, succeeded, failed, unknown or cancelled; worker recovery |
| providerRequestId, result JSONB, errorCode | Bounded external outcome/reconciliation evidence |
| createdAt, startedAt, finishedAt | Operational timing; distinct from customer consent expiry |

Unique(customerId, idempotencyKey) is the logical effect claim. Index ready work by
status/nextAttemptAt and unknown work by status/startedAt. Claim with a transaction
and lease token; a late worker cannot overwrite a newer lease's result.

The engine command's expectedRevision refers to the state before accepting the
decision. Store it as decisionExpectedRevision for transaction CAS/audit. For work
that runs after the accepted transition, store executionRevision from that decision's
nextOperation.revision. For example, applying from revision 3 to 4 checks 3 while
committing, then the worker verifies operation revision 4 and applying state. It must
not compare the already-advanced operation against 3 and reject every valid command.
For check_availability, the emitted operationRevision must equal executionRevision.
Persist the relevant result provenance; do not rewrite the pure engine descriptor.

Business-mutation and proposal/clarification commands require operationId and their
declared evidence/preconditions. read_information and authorized artifact actions
may omit operationId; validate their account/booking/event scope without creating a
new active booking operation. Their operation revisions are null when there is no
operation. Every command still carries the current routing owner/ownershipEpoch.
Incidental information events may change aggregate revision without invalidating
an otherwise unchanged operation; do not misuse that general revision as the worker
effect guard. Never bump BookingDraft.version to implement any of these checks.

Availability result scope includes operation ID/revision, edition, date and excluded
booking. Invoice and Calendar projections are separate commands/results from the
booking mutation. Never mark them successful merely because the booking DB update
succeeded. Delivery commands reference evidence; transport success does not rewrite
proposal values or pretend a payment/business action succeeded.

## 3. Constraints, ownership and compatibility

Use same-customer composite FKs for operations, blocks, evidence, commands and
session pointers. New children need UNIQUE(customerId, id) even where id is already
globally unique. Add corresponding unique indexes on Booking and BookingDraft only
where required for same-customer target/provenance FKs. These indexes are additive
metadata changes, not updates to booking/payment values; review their locking costs.
Message also needs UNIQUE(customerId, id) for the normalized membership FK above.

CHECK constraints validate JSON object shape, finite states/kinds, nonnegative
revision/attempt values, valid terminal timestamps and blocked-reference exclusivity.
The adapter performs schema-versioned field/provenance validation as well. CHECK
constraints cannot look up another table to verify a payment's customer ownership;
validate Payment ownership through its stored booking/draft relationship and command
provenance in the transaction. Unresolvable payment ownership requires reconciliation.

Cross-row active-pointer/state consistency needs a transaction and, if chosen,
deferred constraint triggers; it is not implementable as an ordinary cross-table CHECK.
No cascade deletes of workflow evidence are proposed. Restrict/soft-archive is the
recommendation, but P06 must review existing customer-deletion and retention behavior
before adding FKs that could change that behavior in production.

Membership claims, ownership transfers and writes to referenced legacy drafts must
be included in writer-fencing tests, including legacy expiry/delete paths. Restricted
FKs can expose old cleanup assumptions; dormant tables alone do not test compatibility.

New opaque IDs should not embed a real phone number or raw provider turn ID. The
current core constructs some IDs from customerId/turnId; before persistence, review
an injected deterministic server ID factory and keep all operation/evidence/command
references consistent. Do not rename emitted IDs opportunistically in one adapter.
Never log raw PII as an idempotency key. IDs, dedup keys and payload versions must
be stable across retries and reconstructed snapshots.

Unknown states/versions or contradictory pointers cause an inconsistent snapshot,
not an empty/new conversation. Dates, times, account/recipient identity and payment
facts are validated before the core receives status=ready.

## 4. Transaction and execution protocol

1. Validate/deduplicate the inbound event and establish its account/channel ownership.
2. Ensure and lock that customer's workflow_sessions row in a short DB transaction.
3. Read operation/block/evidence plus required business records; record aggregate
   revision and any booking dateTime/status/service/updatedAt fingerprint.
4. Build the verified snapshot, resolve input and call the pure engine with trusted origin.
5. Compare expected active operation ID/revision with current values. Persist planned
   operation/block/evidence, event decision and outbox commands atomically; bump the
   aggregate revision. A block-only update does not bump the legacy payment counter.
6. Commit before any provider, Calendar or messaging IO. No network call holds a row lock.
7. Claim eligible commands and execute/reconcile using stored immutable inputs.
8. Record results and verified delivery events with compare-and-set preconditions,
   then feed trusted, scoped result events through the same decision boundary.

Acquire the ownership epoch from the locked session and bind commands to it.
Workers check the committed execution revision, owner/epoch and lease before effects.
Do not transfer ownership while commands are running or outcomes are unknown.
A fence check cannot recall a request already sent over the network; an in-flight
effect must be reconciled before transfer/rollback rather than assumed cancelled.

For business DB mutations, validate the booking fingerprint/consent/policy in the
same transaction as the exact-row update and journal result. Re-read/recompute on
changed facts. A Booking revision column is not assumed; current expected fields
can support a guarded update while a separate version design remains optional.

A worker crash after an external request but before recording its response yields
unknown, not failed. STK requests with unknown outcomes are not automatically retried.
Reconcile by stored provider identity when available; otherwise require scoped team
review. The database unique key guarantees at-most-once logical claiming, not magically
exactly-once external IO. Retry eligibility is command/provider-specific and separately
tested; payment attempts remain under existing payment-recovery rules.

## 5. Legacy coexistence and writer fencing

routingOwner is durable per customer, not a process-local map. All operation writers,
channel callbacks, staff actions and legacy handlers must consult the same ownership
boundary before a customer is enabled. Never dual-write old/new operation state.

A feature flag alone cannot fence an old worker that ignores the new tables. Before
rollout, deploy compatible fencing to every writer and retire incompatible processes.
Either prove complete cooperating-writer coverage or implement a reviewed DB-side
legacy-write guard. Any trigger/permissions change is a separate explicit migration
item; do not claim additive new tables alone provide that protection.

When an engine-owned customer has an unresolved legacy draft/payment or an incompatible
legacy writer attempt, block/reconcile rather than invoke the old flow as fallback.
Manual administrative changes must be audited and revalidated against operation state.
Reads, reminders and message logging remain permitted without becoming writer consent.

## 6. Migration plan (not execution authorization)

| Gate | Action | Stop condition |
| --- | --- | --- |
| M01: approve target | Operator confirms isolated DB identity, no live wiring, backup/PITR and restore procedure | No approved isolated target or exposed/unrotated credentials |
| M02: baseline | Compare actual isolated schema and migration ledger with repository; establish reviewed baseline | No migration history alignment, unknown drift or destructive generated SQL |
| M03: review DDL | Author explicit additive tables/indexes/FKs/checks after P01-P06 approval | Any legacy data update/delete, price change or surprise schema conversion |
| M04: isolated rehearsal | Apply only to isolated DB; inspect metadata; generate compatible Prisma client; run transaction/concurrency tests | Ownership/constraints/restart/lease/delivery tests fail |
| M05: fenced dormant release | Deploy compatible code with workflow disabled and no backfill | Any old writer can bypass ownership or missing schema produces partial startup |
| M06: scoped adoption | Select test customer/exact booking, inspect legacy state, switch owner transactionally | Unresolved payment, ambiguous target, unverified legacy conflict or human review absent |
| M07: canary reschedule | Enable only the approved reschedule path, monitor events/effects and execute incident replays | Wrong target, repeated mutation, state loss or unverified completion |
| M08: expand | Review evidence before adding other workflows/customers | Pending replay gates or unowned reconciliation queue |

No prisma db push, blanket migrate/reset, live connection or migration command is
authorized by this design. Existing remote tables do not prove the repository has
a valid migration baseline. Prisma config/version compatibility and migration-client
behavior must be checked on the isolated target before authoring executable artifacts.

Initial migration creates no workflow operations for all existing customers. Do not
infer blocks or proposals by scanning assistant prose. Legacy state may be adopted
only by an approved adapter with verified target, provenance and effect status; the
exact original rows remain auditable. Unknown old drafts are reviewed, not deleted.

## 7. Rollback and partial-failure plan

| Situation | Safe action | Unsafe action |
| --- | --- | --- |
| Isolated rehearsal fails, no external effects | Restore isolated snapshot or remove only reviewed new structures after retaining diagnostics | Reset a shared/live DB |
| Dormant production tables/code, no adopted customers | Disable feature; keep additive tables; revert compatible code if reviewed | Drop tables reflexively or change financial history |
| Active operation, no effects, legacy-compatible state | Stop new work, retain audit, transactionally transfer ownership only with an approved verified conversion | Route into legacy with no compatible draft/evidence |
| Pending/unknown command or payment | Stop new mutating work, retain ownership, reconcile exact effect and lease | Delete command or retry from a fresh draft |
| Booking DB updated, Calendar/invoice/send failed | Keep successful booking fact; reconcile each failed projection | Claim unchanged booking or repeat successful mutation |
| New state cannot be represented by legacy | Keep engine-owned customer safely blocked/handed off while compatible code remains | Switch owner to legacy and discard block/clarification/consent |

Disabling new routing is not equivalent to making all customers legacy-owned. Existing
engine-owned operations must drain or be reconciled. Keep a compatible read/reconcile
path available; blanket code rollback to handlers unaware of ownership is unsafe.
Production rollback normally leaves additive schema intact. Destructive down-migration
is not approved while any event/evidence/command or financial link requires those rows.
Database restoration after real effects must reconcile provider/Calendar outcomes;
restoring a backup cannot undo an external payment or sent message.

## 8. Isolated-database acceptance gates

- ST01: two workers try to begin; one nonterminal operation wins, other recomputes/blocks.
- ST02: cross-customer pointers, targets, evidence and commands fail ownership constraints.
- ST03: crash after atomic decision commit; pending outbox work remains recoverable.
- ST04: duplicate inbound/callback/batch membership cannot reapply a logical mutation.
- ST05: blocked clarification/date/typo chain survives process restart and six-message history.
- ST06: proposal correction and early/same-turn/undelivered consent cannot apply stale action.
- ST07: availability results with wrong target/date/revision cannot create a proposal.
- ST08: unknown STK outcome survives restart without an extra prompt or counter reset.
- ST09: Calendar/invoice/delivery failures preserve successful booking/payment facts.
- ST10: late lease holder cannot overwrite the newer command result.
- ST11: incompatible legacy writer cannot mutate an engine-owned customer.
- ST12: rollback keeps unrepresentable/pending operations safely owned and reviewable.
- ST13: payment attempts and exact policy boundaries remain unchanged by workflow revisions.
- ST14: old/new schema versions and unsupported states fail closed, never as idle.

ST03/ST07 must prove the pre-transition versus execution-revision mapping. ST04
must use two overlapping inbound batches against the membership UNIQUE constraint,
not just two identical parent event keys. ST11/ST12 must cover ownershipEpoch,
running/unknown work and referenced legacy-draft cleanup. ST05 must include an
operation-free name/invoice enquiry without creating a mutating operation.

These tests are planned, not executed. The three end-to-end replay todos remain open
until adapters/executors and isolated persisted-state tests prove the actual behavior.
JSON reconstruction unit tests do not satisfy these PostgreSQL/process/IO gates.

## 9. Approval decisions and next step

| ID | Proposed decision | Approval needed |
| --- | --- | --- |
| P01 | Six additive tables, customer-scoped FKs/indexes, immutable evidence and independent revisions | Storage model, ID factory and actual field/constraint definitions |
| P02 | One durable writer owner per customer; no dual writes; complete legacy fencing | Writer inventory and enforcement approach |
| P03 | Strict verified delivered/shown evidence before action consent; early yes remains unconsumed | Delivery semantics, webhook support and exact customer recovery copy |
| P04 | Isolated rehearsal, no automatic backfill; reschedule-only adoption first | Non-secret isolated target identity, backup/baseline and rollback ownership |
| P05 | Journal unknown effects and reconcile; no blanket external retry or forceful legacy fallback | Named review owner/backup and provider-specific retry/reconciliation rules |
| P06 | Restrict/soft-archive workflow evidence; do not cascade-delete audit | Retention, privacy, existing customer-deletion compatibility and access controls |

Next, review P01-P06. After approval, prepare Prisma/SQL artifacts and the snapshot/
persistence/execution adapter plan against the isolated target. Applying them,
repairing a live draft, enabling customers, committing or deploying each remains
an explicit authorization gate. Writing this design grants none of those actions.

## 10. Technical review result and outstanding inputs

Review completed locally on 2026-10-06. Document validation verifies six entity
sections, eight migration gates, six approval decisions and fourteen planned database
tests, with unique identifiers, ASCII source and a valid engine-document link.
This is structural review, not executed SQL/Prisma/database validation.

Corrections made during review:

- Normalize inbound-member claims inside workflow_events with messageId/parentEventId
  and a UNIQUE constraint. JSON message lists alone cannot fence overlapping batches.
- Separate engine decisionExpectedRevision from the committed executionRevision and
  ownershipEpoch used by command workers. Do not reject every accepted effect by
  comparing the advanced operation to its pre-transition version.
- Permit operation-free information/artifact commands without inventing an active
  booking operation. Mutation/evidence commands still require their operation binding.
- Include Message's scoped uniqueness and legacy expiry/delete paths in ownership and
  compatibility testing. A lease/fence cannot recall already-dispatched external IO.

Outstanding implementation inputs remain:

- An approved isolated target: a new disposable local PostgreSQL database or a named
  isolated staging project/database. This target-selection item is satisfied by the
  user-authorised local Docker target documented in
  [WORKFLOW_TEST_DATABASE.md](WORKFLOW_TEST_DATABASE.md). Identity/connectivity and
  empty-schema checks passed; backup/restore rehearsal and migration authorisation
  remain separate. Do not provide a connection URL/password in chat.
- Approval of P01/P02 storage and fencing details before review-only Prisma/SQL artifacts.
- P03 delivery-evidence and early-confirmation UX decision; callback support must be tested.
- P04 authorised database operator, baseline/backup verification and rollback responsibility.
- P05 named reconciliation owner/backup; marking these unassigned blocks rollout, not review.
- P06 approved retention/deletion/access policy; no indefinite production audit retention
  or changed customer-deletion behavior is silently authorised by this recommendation.

No application tests were rerun for this documentation-only review. Phase 3's recorded
497-pass suite, pure-core evidence and three pending integration todos remain historical
baseline evidence, not fresh database acceptance results. No schema or live data was
read or changed, and no SQL was applied or customer switched to the new engine.