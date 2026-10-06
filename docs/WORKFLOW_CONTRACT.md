# Workflow hardening: Phase 2 contract

Status: D01-D08 behavioral decisions approved by the user's go-ahead on 2026-10-06.
Implementation and runtime acceptance remain separately gated.
Scope: behavioral contract and acceptance criteria only. No code, schema, business
policy, customer record, migration, commit or deployment is authorized by this file.
States and fields below are logical requirements, not new Prisma declarations.

## 1. Purpose and evidence

One decision engine must control intent, permitted transitions and actions. The
model may suggest intent, extracted values and wording; it cannot make a transition
valid, resume a blocked operation or substitute chat text for stored business facts.

Inputs to this contract:

- WORKFLOW_HARDENING_BASELINE.md: 477/477 default checks, 16 replay checks and three
  explicitly pending workflow gates. These are baseline results, not parity approval.
- ../src/services/agent/workflow-baseline.fixtures.json: four reported incidents,
  thirteen turns, synthetic identifiers and an explicitly hypothetical draft conflict.
- ../prisma/schema.prisma: separate Booking/Payment records but one BookingDraft
  per customer; the current draft is shared across different operation types.
- ../src/services/agent/payment-recovery.ts: retry, hold and reconciliation constraints.
- ../src/utils/booking-policy.ts: existing 72-hour policy boundaries.

No live draft or profile has been inspected. The reported conflict is evidence of
a blocking branch, not proof of a particular stale row's contents or safe deletion.

## 2. Approved behavioral decisions

| ID | Decision | Boundary |
| --- | --- | --- |
| D01 | Resolve intent and authoritative context before workflow writes | Audit/metrics and inbound-message persistence do not grant action consent |
| D02 | At most one active mutating operation per customer initially | Preserve competing requests; do not silently overwrite, cancel or suspend them |
| D03 | Persist blocked-request context separately from the conflicting operation | Block survives clarification, restart, short history and provider errors |
| D04 | Allow informational enquiries while an operation is blocked | They cannot clear the block or seed collection; invoice projection/delivery effects are declared |
| D05 | Clarify ambiguous time typos such as 1oam before accepting a candidate | A yes to clarification only accepts the time, never sends payment or applies a booking change |
| D06 | Bind existing-booking actions to a verified, customer-owned booking ID | Multiple sessions require target selection; no default-earliest mutation |
| D07 | Require a visible, recorded proposal and later explicit customer consent | Consent is bound to operation, proposal version, target and action kind |
| D08 | Preserve blocked operations and uncertain external effects until reconciliation | No automated live legacy-draft cleanup based on transcript similarity alone |

D01-D08 are approved behavior, not claims that the current application implements them.
This contract does not add suspension of a live operation as an automatic recovery
mechanism. Supporting pause/switch later requires preservation and consent design.

## 3. Authoritative facts and precedence

| Fact | Authoritative source | Must not substitute |
| --- | --- | --- |
| Customer name | Valid customer-stated Customer.name, with provenance | Booking recipient, model inference, WhatsApp placeholder or command-shaped string |
| Session recipient | Explicit recipient fields on the selected booking/operation | The account holder's name without evidence |
| Confirmed edition/date/time/status | Customer-owned Booking record | A collecting draft, summary memory or assistant claim |
| Paid amount and receipt | Successful Payment rows linked to that booking | Confirmed status alone, a customer payment claim or provider timeout |
| Current operation and missing fields | Validated persisted operation snapshot | Last assistant wording, six-message transcript window or model tool choice |
| Proposed target/date/time | Customer-stated values accepted by the engine | Rejected dates, reference dates or invented defaults |
| Selected extras | Booking-linked add-on rows and qualifying explicit choices | Catalog discussion, hypothetical enquiries or an unverified acknowledgement |
| Invoice totals | Selected booking, validated package pricing, linked extras and successful payments | Model arithmetic or another booking's latest invoice |
| Available slots | Successful availability query for edition/duration/date, excluding the selected booking when appropriate | Mention of a weekday or a model's suggestion |
| Price, deposit and policy | Validated configuration/catalog and existing policy functions | Unapproved knowledge-source conflicts or a stylistic prompt |

The customer can provide a correction or proposed value, but that does not change
a paid booking until the relevant transition is accepted. If sources disagree,
do not pick whichever value appeared most recently in chat. Explain the specific
uncertainty, ask one discriminating question or hand off without inventing facts.

An existing booking and a request for a separate new session may coexist. Label
them explicitly. Never use the old booking to fill a new session's date/time.

## 4. Logical turn snapshot and decision output

Before deciding, obtain a consistent logical snapshot containing:

- Customer identity, channel capability and a deduplicated inbound turn ID.
- Relevant confirmed bookings, recipient identity, linked extras and payment facts.
- Active operation identity, kind, target, state, accepted slots and revision.
- Blocked request identity, intended action, conflict reference and recovery reason.
- Clarification purpose/candidate and outstanding proposal/consent evidence.
- External action status: not attempted, pending, succeeded, failed or unknown.
- Current business clock and relevant expiry/policy facts.

Each supplied value needs a source and ownership/scope check. Snapshot-load failure
produces a safe verification failure, not an empty snapshot or a fresh collection.

The decision engine returns a typed decision, conceptually:

- Decision ID, resolved intent, selected target and operation revision.
- Permitted next state, or a reason that the existing state must remain unchanged.
- Required missing field/clarification, with one next question.
- Explicit commands and their preconditions, idempotency scope and expected results.
- Code-owned reply facts/template and permitted model-rendering scope.
- Outcome: information_answered, clarification_requested, proposal_presented,
  action_applied, blocked, reconciliation_pending, handoff_requested or failed.

These names are a contract vocabulary. Phase 3 will choose the actual types/API.
Successful message delivery is logged separately from successful action completion.

## 5. Turn execution order

1. Persist/deduplicate inbound input and assemble the debounced customer turn.
2. Apply channel, maintenance, quota and safety gates. They must not mutate bookings.
3. Load authoritative facts and active/blocked operation state.
4. Resolve intent, target and ambiguity against that snapshot. Model suggestions
   are untrusted; uncertain intent produces clarification without business writes.
5. Compute a pure permitted transition and commands. Reject incompatible actions.
6. Persist the accepted transition with revision/ownership preconditions before
   executing eligible effects. Re-read/recompute on a concurrent-state conflict.
7. Execute commands idempotently and record actual results or uncertainty.
8. Render from accepted state/results; verify workflow correctness before style.
9. Deliver and record the response. A delivery failure does not undo a successful
   booking/payment effect or authorize repeating it.

Callbacks, reminders and staff updates must enter this same logical transition
boundary with their event identity. A process-local debounce lock alone does not
certify serialization across workers or after restart.

## 6. Operation states

An operation has a kind (new_booking, reschedule, cancellation, addon_change or
artifact_delivery) and a state. Confirmed Booking status is not an operation state.

| State | Meaning | Allowed next step |
| --- | --- | --- |
| idle | No active mutating operation | Answer facts or explicitly begin an operation |
| selecting_target | Required existing booking not yet unambiguously selected | Ask which stored session; no mutation/proposal |
| collecting | Engine is gathering only missing customer-stated fields | Accept valid values or answer a side enquiry while retaining state |
| clarifying | A particular value/intent needs customer clarification | Accept only an answer to that recorded clarification |
| checking_availability | A declared availability read is pending | Show its result or preserve context on failure |
| awaiting_confirmation | A versioned proposal has been presented | Explicit later consent, correction, withdrawal or expiry |
| payment_open | A consented payment attempt is pending or uncertain | Observe, reconcile, or run an eligible explicitly consented retry |
| applying | A consented non-payment action has been claimed | Record result; duplicate events do not reapply it |
| reconciling | External action outcome is unknown or projections are out of sync | Verify the exact action; no blind repeat or fabricated success |
| completed | The requested action is durably applied | Acknowledge or begin a separately requested operation |
| withdrawn | Customer withdrew the operation, not the underlying confirmed booking | Preserve business records and invalidate pending consent |
| expired | Operation/proposal is no longer actionable | Retain audit and facts; revalidate before making a fresh proposal |
| blocked | A competing/unsafe state prevents the requested transition | Explain/reconcile the specific block; do not model-resume |
| handed_off | A persistent team-review request exists | Keep accurate status until verified staff resolution |

Blocked and handed-off states may overlay a requested operation while the original
competing operation is preserved. This is not permission to replace the existing
BookingDraft. Physical storage and schema compatibility are decided separately.

## 7. Global transition rules

| ID | Event / condition | Required behavior | Forbidden behavior |
| --- | --- | --- | --- |
| G01 | Name/session/payment/add-on enquiry | Answer scoped stored facts; retain operation | Seed collection or ask again for valid known details |
| G02 | Explicit new operation, no conflict | Validate target and enter appropriate state | Mutate first and classify intent later |
| G03 | Multiple possible target bookings | selecting_target | Select earliest booking for an action without customer identification |
| G04 | Competing operation or uncertain effects | blocked/reconciling with specific reason | Overwrite the old operation, erase payment links or resume via wording |
| G05 | I don't understand while blocked | Code-owned explanation and permitted recovery choices; still blocked | Ask for a new date/time as if the block disappeared |
| G06 | Informational detour | Answer without dropping accepted slots or pending action identity | Interpret the answer as another workflow's name/date/consent |
| G07 | Ambiguous value/typo | clarifying with a recorded candidate and purpose | Commit guessed time or treat clarification yes as action consent |
| G08 | Provider outage | Keep state; use a grounded deterministic response or handoff | Ask for all known details again or turn missing model output into success |
| G09 | Duplicate/stale event | Return recorded result or recompute against current revision | Replay payment/booking mutations |
| G10 | Restart/history truncation/reminder | Restore from persisted state, not assistant prose | Lose blocked/selected-date context or change recipient identity |
| G11 | Superseded/expired proposal | Invalidate old consent and present a revalidated proposal if requested | Apply an old yes to a different version/target/action |
| G12 | Unknown schema/data/source conflict | Safe failure or handoff with accurate facts | Silently treat missing data as no booking/no operation |

## 8. Workflow-specific transitions

### 8.1 New booking and identity

| From / event | To | Required action |
| --- | --- | --- |
| idle + explicit new booking | collecting | Reuse valid account identity for self-booking; do not reuse an old session's slots |
| collecting + valid field | collecting/checking_availability | Accept only the expected field or an explicit correction; preserve other fields |
| collecting + missing identity | collecting | Ask for a usable name; a first name remains sufficient during collection |
| collecting + booking for someone else | collecting | Separate account identity from explicitly captured recipient identity |
| accepted edition/date/time + availability success | collecting/awaiting_confirmation | Honor the existing optional-extra decision and proposal prerequisites |
| ready + proposal presented | awaiting_confirmation | Record validated edition, date/time, deposit, target and proposal evidence; no STK push |
| awaiting_confirmation + later eligible consent | payment_open | Run the existing guarded payment initiation exactly once |

Name statements cannot be inferred from generic acknowledgements, invoice commands
or unrelated conversational sentences. A full-name request cannot restart collection
when a valid customer name is already saved. Existing proposal validation is reused;
this contract does not introduce a stricter customer-name business requirement.

### 8.2 Payment

| From / event | To | Required action |
| --- | --- | --- |
| payment_open + waiting/not-arrived enquiry | payment_open/reconciling | Read actual attempt state; do not resend merely because the customer asks about status |
| payment_open + retry consent + existing eligibility checks | payment_open | Retain booking fields; obey attempt limit, cooldown and unknown-transaction guard |
| payment_open + authenticated successful callback | completed/reconciling | Claim event idempotently; apply payment/booking completion once and record follow-up effects |
| payment_open + failed/cancelled/timeout result | collecting/awaiting_confirmation/payment_open as validated | Preserve fields and payment audit; distinguish known failure from unknown outcome |
| customer claims payment without verified success | reconciling | Verify receipt/attempt; never declare paid from the claim alone |

The existing payment attempt accounting derives attempts from BookingDraft.version.
Generic operation revisions must not reuse that counter or change retry eligibility.
Separate accounting/revision design is a prerequisite to implementation.
Closing a conversational operation must not cancel an unresolved external payment.

### 8.3 Rescheduling

| From / event | To | Required action |
| --- | --- | --- |
| idle + reschedule request | selecting_target/collecting/blocked | Bind the exact confirmed booking before any new-booking capture |
| collecting + busy that Friday / another date | collecting | Treat Friday as rejected/reference data; ask for missing replacement date/time |
| collecting + date-only availability enquiry | checking_availability -> collecting | Query actual slots for stored edition/duration, excluding current booking; display bounded times |
| collecting + explicit replacement date | collecting | Persist accepted date; if time absent, ask only for time |
| collecting + time-only value | collecting/checking_availability | Use a persisted replacement date; use original date only for explicit same-day/time-only intent |
| collecting + 1oam | clarifying | Ask whether 10:00 AM was intended; preserve selected date and target; no booking mutation |
| clarifying + yes to time candidate | collecting/checking_availability | Accept time candidate only; then validate availability and present a proposal |
| valid target/date/time + availability success | awaiting_confirmation | Show old and proposed session, unchanged edition/extras and applicable existing policy |
| awaiting_confirmation + eligible later consent | applying -> completed/reconciling | Recheck ownership/revision/slot/policy as required; update the same booking exactly once |

If no slots are available, retain the operation and show the truthful result or
alternatives. A failed availability read must not be represented as fully booked.
A declined proposal leaves the original confirmed booking unchanged. Successful
rescheduling preserves extras and payment records, except effects explicitly
required by the existing policy; it does not invent a new refund or deposit rule.

### 8.4 Cancellation

| From / event | To | Required action |
| --- | --- | --- |
| explicit cancellation | selecting_target/awaiting_confirmation/blocked | Identify exact booking and state current refund eligibility; cancel nothing yet |
| valid later explicit yes/yeah/yep/ndio/confirm | applying -> completed/reconciling | Claim and apply the existing cancellation behavior once |
| okay/sawa, decline, unrelated turn or expiry | awaiting_confirmation/withdrawn/expired per current rules | Do not infer consent; invalidate unrelated stale cancellation consent as today |

Existing cancellation consent rules are intentionally stricter than casual
acknowledgement. Informational detours still answer valid facts, but they cannot
keep stale cancellation consent alive contrary to the current cancellation rules.
State refund eligibility, not an unverified refund amount or claim of money returned.

### 8.5 Extras and invoices

| Event | Required outcome | Effect boundary |
| --- | --- | --- |
| Catalog/hypothetical extra question | Approved item information/link | No extra saved |
| Explicit extra selection | Validate item, quantity, recipient and session identity | Save once to exact booking/operation; ambiguous targets require selection |
| Have you added the add-on? | Read scoped saved rows and explain linked/pending status | No catalog substitution or unverified nothing-added statement |
| Invoice request | Identify the correct booking invoice, refresh validated totals and deliver if requested | No name/edition capture, STK push or new booking |
| Invoice refresh/delivery failure | Distinguish refresh failure from delivery failure; preserve booking/extras | No fabricated updated invoice or duplicate charge |

Invoice projection and requested document delivery may write artifact/send-status
records. They are declared effects, not new-booking or reschedule transitions.
Whether add-on selection automatically refreshes/delivers an invoice is not changed
by this contract; current invoice-request refresh behavior remains the baseline.
An explicit additional quantity differs from a duplicate retry of the same selection.

## 9. Conflict recovery and handoff

| Conflict class | Permitted recovery | Not permitted |
| --- | --- | --- |
| Valid unrelated collection/proposal | Explain which request conflicts; offer continue that request or team review | Silently replace it to begin rescheduling |
| Active/unknown payment attempt | Verify/reconcile exact attempt before switching operations | Abandon/delete it or issue another STK push based on chat alone |
| Proven expired operation without unresolved effects | Logically expire/archive that exact operation under approved expiry rules | Cancel the confirmed booking or delete payment/invoice history |
| Legacy/suspicious draft with uncertain provenance | Team review or scoped operator inspection before targeted repair | Assume it is stale because it resembles the reported transcript |
| Ambiguous/missing booking target | Ask a precise target question or team verification | Bind the earliest session or infer a booking from model text |
| Concurrent state change | Re-read and recompute; explain actual outcome if necessary | Continue a stale decision against another operation's state |

Blocked-request recovery must persist its reason and competing operation identity.
"I don't understand" restates that reason in customer language, with one permitted
next action. Availability may be read-only information while blocked, but its reply
must explicitly preserve the block; accepted operation slots cannot be silently
written into the conflicting operation. Keeping a customer's desired value as
non-actionable blocked-request context must be distinguished from an accepted slot.

Handoff requires a durable request with reason, target, correlation ID and review
status. Requested, assigned, acknowledged and resolved are different facts. No
same-day reply or named owner is promised until staffing/ownership is confirmed.
Verified staff resolution must arrive through an auditable event before unblocking.
Unknown blocks remain blocked across restarts; elapsed chat time alone is not repair.

## 10. Confirmation, expiry and policy boundaries

Confirmation is valid only for a prior-turn proposal actually delivered/presented
to the customer, with recorded message/turn identity, operation ID, target, proposal
version and action kind. A yes in the same debounced turn as a new proposal cannot
confirm it. A yes to a time clarification cannot charge a deposit, cancel or reschedule.
Correcting target/date/time/policy-relevant facts supersedes the old proposal.

| Existing boundary | Source | Contract treatment |
| --- | --- | --- |
| Collecting-slot retention: 14 days | config/constants.ts | Preserve value; migrate expiry semantics only with explicit approval |
| Reschedule context: 24 hours | agent/constants.ts | Expired context cannot authorize a change; retain booking facts |
| Cancellation proposal: 1 hour | agent/constants.ts | Expired consent is invalid; unrelated-message handling remains strict |
| Payment hold: 15 minutes | payment-recovery.ts | Hold expiry is not proof that an external payment failed |
| Prompt timeout: 2 minutes; retry cooldown: 30 seconds; max attempts: 3 | payment-recovery.ts | Preserve existing eligibility checks; distinguish timeout from unknown effects |
| Reschedule forfeiture: future booking strictly less than 72 hours away | utils/booking-policy.ts | Preserve exact function behavior and disclosure; do not relabel payment as refunded |
| Cancellation refund eligibility: strictly more than 72 hours away | utils/booking-policy.ts | Preserve exact boundary, including equality; report eligibility only |

At exactly 72 hours the current function returns neither reschedule forfeiture nor
cancellation refund eligibility. This asymmetric boundary is recorded, not changed.
No new new-booking-proposal TTL is invented here. Its implementation rule must be
resolved from approved existing hold behavior before Phase 3 changes it.

Information messages, reminders and background logs must not accidentally extend
consent or reset attempt age. Future storage needs appropriate timestamps rather
than assuming generic row updatedAt measures every business deadline.

## 11. Side-effect safety and response verification

Each mutating command must check customer ownership, target identity, current
operation revision, valid consent, availability/policy where applicable and an
idempotency scope. Pending/unknown external effects require reconciliation, not
blind retry. Duplicate inbound messages and callback deliveries return/observe
recorded results rather than apply the mutation again.

Database booking success, Calendar sync, invoice refresh and message delivery are
distinct results. If booking update succeeded but Calendar sync failed, do not claim
the booking was unchanged or replay the update; reconcile the failed projection.
Physical transactions, command journal/outbox and compensations are storage/design
choices for later review, not guarantees supplied by this document.

Before style/emoji processing, a workflow verifier must assert:

- The reply matches the engine decision and actual action results.
- A blocked/reconciling state is not portrayed as resumed/completed.
- The requested information/action has been answered or its specific failure explained.
- Only genuinely missing or uncertain fields are requested.
- Payment, confirmation, cancellation and refund claims have their own evidence.
- Booking/operation/recipient identities are not mixed and pending consent is scoped.

Reject invalid workflow wording with a code-owned grounded reply. Do not spend a
provider retry trying to change authoritative state. Existing amount/policy/content
verification and exact financial templates remain in place. Emoji policy remains
subject to its separate copy/whitelist approval and cannot alter action meaning.

## 12. Acceptance matrix

These are future executable behavioral gates, not assertions passed in Phase 2.

| ID | Setup and event | Required assertion |
| --- | --- | --- |
| AC01 | paid-session-addon-invoice fixture | Same booking, one chosen extra, deposit unchanged; invoice request refreshes total 35000/paid 2000/balance 33000 without collection |
| AC02 | identity-and-addon-recall fixture | Durable synthetic account name and linked extras read directly; recipient/catalog cannot replace them |
| AC03 | initial-reschedule-rejected-date fixture | Initial intent precedes slot capture; Friday not accepted as replacement; no collecting_slots draft or mutation |
| AC04 | blocked-reschedule-typo-recovery fixture through i dont understand | Competing operation unchanged; blocked request still blocked; no model-led resume |
| AC05 | Valid reschedule + date-only availability on 10th | Query correct edition/date with selected booking excluded; return actual bounded slots before asking for time |
| AC06 | Same enquiry while blocked | Explain block consistently; any informational query cannot authorize/seed a reschedule |
| AC07 | Stored replacement date + 1oam | Recorded time clarification only; date/target retained; clarification yes not action consent |
| AC08 | Typo/provider outage followed by on 10th at 10am | Valid operation continues, or existing block is explained; no package question or new collection |
| AC09 | Eight reminders, six-message history and process restart | Accepted slots, target, block and pending consent restored from persistence |
| AC10 | Genuine separate new booking alongside paid existing session | Known account identity retained; old session slots not copied; flows explicitly distinguished |
| AC11 | Multiple upcoming sessions | No mutating target chosen until customer identifies the session |
| AC12 | Date/time correction or superseded proposal + old yes | No stale action applied; fresh proposal required |
| AC13 | Proposal and yes batched in one customer turn | No same-turn charge/reschedule/cancellation |
| AC14 | Duplicate inbound/callback or two workers | One accepted revision and at-most-once logical mutation; recorded external effect reconciled |
| AC15 | Pending/unknown payment + conflicting request | No draft deletion, additional unconsented STK push or false unpaid/paid claim |
| AC16 | 71:59:59, exactly 72h and 72:00:01 before session | Existing forfeiture/eligibility function boundaries unchanged |
| AC17 | Successful booking update, failed Calendar/invoice/message effect | Correct partial-success statement and reconciliation; no repeated booking mutation |
| AC18 | Unknown schema or failed authoritative-state load | Safe failure/handoff, never empty-state collection |
| AC19 | Cancellation no/okay/sawa/unrelated turn/expired proposal | Existing strict consent and withdrawal/expiry behavior preserved; no unauthorized cancel/refund |
| AC20 | Staff review requested but unassigned/unacknowledged | No claim of ownership, acknowledgement, resolution or guaranteed reply time |

AC04, AC05 and AC07-AC09 expand the three Phase 1 test.todo gates. Every frozen
incident maps to at least one acceptance ID. Tests must assert state and command
counts, not only sentence matching. Use a controlled business clock and synthetic
records. Later persisted-state tests require a separately approved isolated database;
they must not use the configured production account or real customer number.

## 13. Implementation boundaries and next gates

Current implementation surfaces to adapt after approval:

- agent.service.ts / routes.ts: replace competing pre-capture shortcuts with the
  authoritative snapshot and decision boundary; retain operational gates.
- conversation-flow.matcher.ts / extraction.ts / slot-memory.ts: suggestions and
  field validation, not permission to write arbitrary operation state.
- booking-progress.ts / booking-tools.ts / payment-recovery.ts: expose validated
  commands and results; preserve existing financial and policy checks.
- invoice-tools.ts / session-tools.ts / appointment-replies.ts: scoped target-aware
  informational and artifact actions that cannot resume unrelated operations.
- messaging/debounce.service.ts and channel callbacks: deduplicated events into the
  same transition contract; process-local queues alone are insufficient.
- output-verifier.ts: workflow-decision assertions before optional voice rendering.

Approval checkpoints:

- [x] Approve D01-D08 and the transition/acceptance contract (user go-ahead, 2026-10-06).
- [ ] Choose physical storage for operations, blocks, clarifications and consent evidence;
      account for existing one-draft-per-customer constraint and payment version coupling.
- [ ] Confirm proposal expiry/delivery-evidence rules where the current implementation
      lacks a stable durable source; do not introduce an implicit business policy.
- [ ] Confirm handoff owner/backup, review acknowledgement and permitted conflict recovery.
- [ ] Approve isolated database, migration baseline and rollback design before persistence changes.
- [ ] Replace pending gates with executable tests and migrate one workflow at a time.

Phase 2 ends at contract review. No live cleanup, schema application, model/provider
change or runtime hardening is implemented merely by approving this document.

The Phase 3 pure decision core is described in
[WORKFLOW_ENGINE_CORE.md](WORKFLOW_ENGINE_CORE.md). Runtime adapters and the three
end-to-end replay gates remain pending; core tests are not live-workflow certification.