# Observed run regression fixes

## Initial reschedule intent before slot capture (2026-10-06)

The exact Muse follow-up "thats nice can we kindly reschedule it to some other
date...i will be busy that Friday" reproduced a package question before any route
ran. New-booking slot capture interpreted Friday as a stated date and intercepted
the initial reschedule request. Prior protection only covered answers to an existing
assistant reschedule question, not the initial customer request.

A deterministic rescheduleEntry route now runs after budget/circuit checks but
before slot capture. It uses an unambiguous upcoming confirmed booking, persists
the existing reschedule context and asks for a replacement date/time. It rejects
unrelated active drafts and clarifies multiple bookings without writing a draft.
Negated reschedule requests still reach withdrawal rather than starting a move.

Replacement-date parsing excludes busy/unavailable/cannot-attend clauses and takes
the target in "from ... to ..." wording. Explicit replacement dates and times use
the existing availability/proposal flow. Date-only picks persist in that booking's
reschedule context, surviving trimmed history and reminders. Proposal queries now
retain the bound bookingId rather than silently choosing the earliest booking.
The actual booking, payment and extras stay unchanged until explicit confirmation;
existing 72-hour disclosure and confirmation rules are preserved.

Verification: eleven mocked reschedule-flow tests pass, including the exact opening,
explicit target then confirmation, date-only/time follow-up after eight reminders,
ambiguity, missing bookings and protected drafts. Route characterizations pass;
existing replay passes 15/15. TypeScript and editor diagnostics pass.
The full suite reported 473/477: three unrelated extraction tests still call the
instance regexExtract API after a concurrent change made it static; one availability
test asserts a fixed 6 October 2026 13:00 slot despite real-time past-slot filtering.
Those unrelated paths were not changed or claimed green in this phase.

Tests disabled configured database access via an unreachable local endpoint and
mocked external operations. No live record inspection, stale-draft cleanup, payment,
Calendar operation, schema change, deployment or commit was performed. Clause parsing
is a conservative local rule, not general natural-language intent certification.

## Durable customer name and saved-add-on status (2026-10-06)

"So whats my name? Do you know it?" previously reached the model even though
customer names are persisted in Customer.name. A deterministic customerName route
now reads that profile directly, never a session recipient or trimmed chat history.
Missing, placeholder and obvious command-shaped names produce an honest request
for a name; storage failures produce a verification fallback. No profile is reset.
Name questions bypass early booking-slot capture. The repeat-question guard also
recognizes "share/provide your full name", including without a collecting draft.

"Have you added the add-on" previously matched the additions catalog. Status
wording now routes to the existing stored-extra lookup, bypassing slot capture.
The lookup reports extras linked to upcoming non-cancelled sessions. With no such
session, it explicitly says no linked extras were found rather than falling through
to the catalog; failed reads do not claim that nothing was saved. This does not
certify unlinked pending requests or refresh an invoice automatically.

Verification: focused name/status regressions include empty history, a fresh agent
instance, another person's session name, unusable profile values, actual scoped
add-on reads, missing records and storage failures. Final default suite passes
465/465 and existing replay passes 15/15; TypeScript and editor diagnostics pass.
Database access was redirected to an unreachable local endpoint during tests,
with external operations mocked. No live profile inspection/repair, customer message,
payment, migration, deployment or commit was performed.

## Confirmed Muse session and invoice follow-up (2026-10-06)

The reported paid Muse -> Power Suit -> "Okay...is that it?" -> invoice sequence
exposed two local control-flow gaps. Collection progression and repeated-question
protection only covered collecting drafts. In addition, slot capture ran before
invoice routing: after a stale "your name" question, "Send me the invoice" was
parsed as a name answer and could return a package question before reaching the
invoice handler. A red regression reproduced that interception.

- Invoice requests now bypass early slot capture, preserving invoice-route priority.
- Short completion questions read confirmed upcoming bookings and recorded extras
	without relying on chat history. Active drafts take precedence; multiple confirmed
	sessions require clarification. The route makes no payment or booking changes.
- When no active draft exists, model context includes the confirmed edition/date/time
	as known slots. A repeated collection question is replaced with stored session
	details, without claiming payment receipt. Explicit new booking requests still pass.
- A mocked transcript exercises actual add-on persistence and invoice refresh: the
	Power Suit attaches to the same Muse booking, total becomes 35,000, paid deposit
	remains 2,000, and balance becomes 33,000. The edition/date/time are unchanged.

Verification: five focused checks, 455/455 default tests, 15/15 existing replay
checks, TypeScript and editor diagnostics pass. Database access during tests was
redirected to an unreachable local endpoint; external operations in these fixtures
were mocked. No deployment, live customer record inspection, schema change, payment
prompt, Calendar action or commit was performed. Existing live stale drafts or names
have not been reset; production behavior still requires an authorised staging check.

## Memory hardening: draft collision phase (2026-10-05)

The reported restart after STK failure is not proven to be draft loss. The prior
readback found the current proposal intact, and the failed-STK implementation only
changes step back to awaiting_confirmation. The focused rollback regression passes.

Local write-path audit:

- Cancellation proposals already reject collecting_slots and other active flows.
	Collection coverage was added to the existing cancellation regression.
- Reschedule proposals previously upserted the shared customer draft regardless of
	its step. A new regression reproduced this overwrite. They now reject any existing
	draft other than reschedule_confirm before querying availability.
- Reschedule completion previously deleted by customer alone. Cleanup now matches
	draft id, customer, reschedule_confirm step and the associated booking id. A mocked
	replacement collecting draft survives completion cleanup.
- Cancellation completion previously deleted by customer alone. Cleanup now matches
	cancel_confirm and the associated booking id, preserving unrelated booking drafts.
- Reschedule withdrawal and cancellation withdrawal/expiry already filter by step.
- The generic agent-error fallback contains no draft write or deletion. A mocked
	provider failure during an unrelated question preserves the collected slots.
- Recipient-name capture and saveBookingProposal still use shared-row upserts.
	They remain audit findings for the next state-machine phase, not fixed here.
- Early-slot expiry still deletes collecting_slots after the retention period measured
	from row creation. No slotsUpdatedAt migration has been applied.

This is collision protection, not a complete durable-memory design. Proposal guards
use a read before upsert and do not certify safety against simultaneous writers.
Add-on decisions still depend on temporary history/operational notes, not durable
draft identity. A pure next-step function, computed Ask only for context, missing-slot
templates and the requested 20-message no-repeat regression remain the next phase.
The separate-column migration still requires an approved development database and
migration baseline. Increasing history alone does not resolve these risks.

Verification: eight focused mocked checks pass with DATABASE_URL temporarily set to
an unreachable local endpoint; standalone TypeScript checking passes; the existing
mocked replay passes 15/15. The full-suite rerun reported 364 passed and three failed
(two yes-routing characterizations and the generic immediate-confirmation fixture).
An earlier full run exposed a missing deleteMany fixture mock, now repaired and
passing independently. The full suite also emitted actual Prisma foreign-key errors
from incompletely isolated fixtures; it must not be represented as fully mocked or
fully green. No further run against the configured database was performed. No live
customer replay, migration, price/policy change or commit is part of this phase.

## Authenticated database inspection and authorised cleanup

On 2026-10-04 the user shared an authenticated Supabase dashboard for Fiesta AI,
main branch. Scoped SELECTs established the following actual rows:

- THE ICON: price 35,000, deposit 10, duration 2.5 hours.
- The matching test profile's name was literally "No its Joan", not Miriam.
- The exact reported older Icon booking was confirmed for 8 October 2026 at 4 PM
	Nairobi (stored UTC 13:00), with one successful Ksh 10 payment, one invoice and
	a linked Google Calendar event.

The user explicitly authorised setting Icon deposit to 2,000, cancelling this
test-owned booking while preserving payment/invoice, and resetting the profile to
WhatsApp User. A transaction guarded each original row/value and aborted unless
exactly one target matched per update. The dashboard reported success. Independent
readback verified deposit 2,000, booking cancelled, name WhatsApp User, successful
payment count 1/amount 10 and invoice count 1. No refund or financial deletion.

Calendar event linkage remains present. Google Calendar was NOT changed, so this
is database cleanup only, not a complete lifecycle cancellation. The stale Calendar
event can still block availability until the authorised operator clears it. No
draft, customer-memory, message history or other test records were reset. No raw
phone/booking/Calendar ids are persisted in this tracked report. No .env/keys were
read during that cleanup.

## Payment retry investigation

A subsequent authenticated read on 2026-10-04 found exactly one draft on the test
number: THE ICON, 6 October 2026, 15:00, step awaiting_confirmation, with zero
linked payment rows. This verifies the observed post-failure state, independently
of the mocked rollback test. There was no other old draft to remove. The current
Tuesday proposal was preserved for a retry; no draft/history reset was performed.

Scoped inbound-message reads found, in order, "5th at 3pm", "how about 6th at 3pm"
and "lets go with 6th". Thus the retained 3 PM has explicit customer provenance;
the last message did not itself supply a new time. This does not certify full
draft-bound identity or freshness across all stored conversation memory.

All seven live edition rows (Bloom, Muse, Icon, Legend, Queen, Empress and Goddess)
had deposit 2,000. This is stored-data evidence, not owner confirmation of every
edition's inclusions or other policy details. No further package writes occurred.

Local configuration was examined only through presence/format flags, with no
credential values printed or stored. It selects sandbox; all five required fields
are present, without embedded whitespace or quotes. The code uses the sandbox URL
and Basic base64(key:secret) with grant_type=client_credentials. App ownership,
credential rotation, truncation and the running server's environment remain
unverified. No credentials were edited.

Two isolated sandbox OAuth requests failed with HTTP 400. The revised diagnostics
established that the actual response body was empty, not an explanatory Daraja
payload. Do not claim that a particular key/secret mismatch was proven. Logging
now includes environment/status and bounded, redacted standard, nested-fault or
plain-text error bodies, never the entire Axios error/config. Missing/malformed
OAuth credentials and unrecognised environments fail before HTTP. Tokens and
credential values were not exposed. No STK push or production request was made.

Sandbox authentication still needs resolution outside chat. No retry of the
customer's yes, payment callback, booking confirmation or Calendar creation was
performed. Database-credential rotation remains unverified; no production-money
test or deployment is authorised by these checks.

## Code fixes and evidence

### Family styling and retry follow-up (2026-10-05)

A fresh authenticated SELECT still found the same Icon draft for 6 October at
15:00, awaiting_confirmation, with a name and zero payment rows. The rollback did
not clear its slots. No live draft/history reset was performed: sandbox auth is
still blocked, so the conditional clean replay has not started.

Family dress/groom/styling questions, including contextual "them" follow-ups and
session phrasing, now use the exact deterministic reply: "Your partner and children
are welcome. The team will confirm what styling is available for them." The family
route precedes generic welcome information. No family styling add-on or clothing
policy was added. The existing catalog's explicit extra-makeup-for-another-person
selection remains supported; it is not a new general partner-styling service.

The verifier blocks unverified family styling/outfit claims and the customer-facing
phrases "my system", "technical issue", "hiccup" and "glitch". Correction instructions
use the same team-confirm text. This is a targeted lexical guard, not certification
of every possible inclusion/capability claim or a complete FAQ-backed allowlist.
The actual family-styling owner answer is still pending in STAGING_CHECKLIST.md;
no FAQ row was labelled verified and no retrieval/vector operation was performed.

"Where are we at on our booking process?" now reaches draft status before the
process explainer. It includes the stored edition/date/time and the next deposit
step, without claiming payment or confirmation. No draft on that question falls
through to the explainer. "Lets do it then" is explicit payment consent, not a
restart. An awaiting_confirmation draft without a recent visible deposit proposal
repeats its verified proposal rather than sending STK or asking for its slots again.
Cancellation/reschedule proposals still require their own confirmation context.

After an STK error, deterministic recovery reads the rolled-back draft and repeats
its proposal. A new dispatcher regression forces an authentication failure,
asserts package/date/time/name retained and no payment recorded, then retries yes
against that returned proposal. The second push is mocked successful; it is NOT
live payment/callback certification. No real key was intentionally corrupted.

One new sandbox-only OAuth check still returned HTTP 400 with an empty body.
No credentials were edited, no token printed, and no live STK or production call
was made. Credential replacement/app verification must happen outside chat; the
database rotation/dev database and old Calendar cleanup gates remain unresolved.

Latest full suite: 367/367; TypeScript clean. A reschedule protection fixture failed
once in a full run, passed in isolation, and passed in subsequent full runs; no
unrelated production-code change was made for that unexplained transient failure.
All pending source fixes remain uncommitted under the existing Calendar hold.

Confirmation claims now include "confirmed session/appointment/booking" and fail
closed unless an explicit existing-appointment enquiry matches stored confirmed
date/time. Current collecting/pending status is considered before older bookings.
Older appointment AND payment context are labelled separate from the unbooked
request. Exact backend financial confirmations stay pinned.

Deposit evidence is no longer just hypothetical: the Icon row really was 10.
Sandbox proposal tests reproduce Ksh 10; production tests reject it before saving.
The guarded data update fixes that row, not every other edition's values. Quote
lookup is current-edition scoped, uses the draft edition and withholds below-2,000
display amounts. No locale/comma corruption was found and no charging validator,
provider, cap or secret setting was changed. Verify all edition data before launch.

The parser captures I would want the Icon, The icon package and contextual No its
Joan, retains other slots, and handles how about 6th at 3pm. Monday/past-date facts
are answered in code. The observed current profile proves malformed correction
text was stored; it does not prove where the earlier Miriam row originated.

"Have you booked it" now uses deterministic draft status, including missing slots,
instead of falling through to a stale calendar answer. Availability tools reject
unrelated current turns even if the model supplies an old date. Customer-facing
proposals, reschedule proposals, progress offers and availability replies format 15:00 as 3:00 PM;
stored slots and tool arguments remain HH:mm. Calendar bypass replies are assembled
from booking-service results and computed calendar facts, not model prose. A
mocked unrelated availability call performs no calendar lookup and cannot produce
a backend_calendar_reply.

After add-on decision, code rechecks availability, asks the full name only before
proposal, and calls propose_booking rather than confirm_booking. Repeating a usable
first name after the request proceeds rather than loops. Failed saves do not claim
completion. Protected steps bypass continuation; no STK or confirmed booking is
created by this step. Temporary history/operational-note continuity is not 8.1b's
draft-bound identity or distributed idempotency. Old-note/draft reuse still needs
the migration-backed state design.

## Provider and real-model replay still pending

verifierChecked=false is explained by verifierBypassReason: exact_tool_reply,
backend_calendar_reply, known_slot_question_guard, backend_action_guard or empty
model reply. Arbitrary model output is verified unless replaced by safe backend
text. Adapter/state tests are not certification of the real model's tool behavior.

The user reports about 4k tokens for plain and 11k-12k for tool turns; complete
per-call records are not available here. Provider tier/primary choice is pending.
The latest reported turn used 16,195 tokens and four completion calls, including
Groq 429 failover to Gemini. Those are user-reported run figures, not measurements
from the mocked replay or sandbox OAuth checks. No cap or provider change was made.
The user asked about native OpenAI rather than choosing Groq/Gemini. The SDK
currently targets Groq/Gemini; native OpenAI needs a separately approved adapter,
not just another key. ChatGPT subscriptions are separate from API billing. The
intended current model is user-confirmed openai/gpt-oss-20b. No provider switch.

The user reports a fresh controlled identity is ready, but its non-secret staging
target and rotated credential/integration readiness are not supplied. No fresh
real-model Joan replay or verbatim real replies have been produced. Do not use the
existing live-wired account as proof of isolation. Owner answers, credentials/dev
DB, remaining migrations and stale lashes cleanup retain their staging gates.
"Glow" remains a prompt-only ban; labelled staging must catch semantic/style errors.

## Regression and commit boundary

354 default tests and 15 original replay checks were green before the initial
database inspection. The latest full suite passes 360/360, TypeScript is clean and
the original replay passes 15/15. Synthetic regressions use the real dispatcher with mocked storage,
cover the reported Joan turns, name repetition, sandbox/production deposit, old
booking separation, no-extras continuation and no payment action. An initially
misplaced fixture mock was repaired; that attempted lookup was not live-data proof.
The new authenticated SELECT results above are the actual database evidence.

Source fixes and earlier schema safeguards remain uncommitted. Do not claim the
Calendar event is deleted, the account completely reset, or a real replay passed.
The user explicitly chose to hold the commit until the authorised operator removes
the linked old Calendar event. That cleanup has not been verified, and successful
payment/callback validation remains blocked on sandbox authentication. No commit
was made; no production rollout is authorised by data repair.