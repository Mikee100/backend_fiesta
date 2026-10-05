# Staging AI test plan

Planning only. No real-model, database, browser or external channel tests have run
as part of this document. Do not start the current backend with exposed credentials.
No production-number or real-customer testing is authorised by this plan.

## Entry gates

1. Rotate exposed credentials outside chat; use staging-scoped secrets directly in
   the approved secret store, never pasted into model tools.
2. Provision a non-production PostgreSQL database; back it up/baseline migrations,
   approve/apply cancelProposedAt, 8.1b slotContext/slotsUpdatedAt and packages.inclusions
   together. Verify Prisma/client/schema parity without touching production.
3. Delete/re-ingest stale lashes vectors using rotated keys and approved Pinecone
   access. Prefer an isolated staging index; verify retrieval no longer returns the
   retired lashes price. This plan does not execute those operations.
4. Obtain owner-approved edition data, Empress/Bloom answers, flat/varying deposit
   policy, exact-72-hour rules, all-women/professionally-trained team claim and refund
   follow-up owner. Compare staging rows,
   seed/reference lists and retrieval sources read-only; document every conflict.
5. Name the duty reader and backup for handoffs; approve staffed hours, alert channel
   and response target. Test notification delivery plus human acknowledgement before
   enabling the approved "shortly" cutoff. Owner is currently unassigned.
6. Approve 8.8 copy and prompt changes, record commit/provider/model/prompt/index/schema
   versions and freeze the expected facts for the review batch.

## Environment and validation stack

Messaging/API primary stack: existing Node test runner with mocks for offline gates;
isolated Express/chat endpoint against real staging PostgreSQL and the real configured
Groq/Gemini model for supervised staging. Sandbox M-Pesa and isolated Calendar/channel
adapters only. Never send an STK prompt, refund or Calendar change to a real customer.
Use test senders/recipients or a controlled internal chat interface approved by the team.

Read-only local capability checks on 2026-10-04: Docker daemon available; Node
v24.19.0 available. These checks do not mean staging is provisioned. Backend declares
Node ^20, so use that supported runtime for certification or separately resolve the
version discrepancy; local Node 24 test results are not a Node 20 certification.
Do not use SQLite/mock storage as proof of PostgreSQL migration or concurrency parity.

Browser tier is independent: if reviewing the staff dashboard, reuse its deployed
staging UI and Playwright after browser tooling is verified. No browser installation
or UI validation was performed here. API tests cannot prove toast visibility or a
staff member saw an alert. Both notification delivery and acknowledgement need checks.

Canonical offline gates: npx tsc --noEmit -p . and npm test in backend. Last verified
baseline is 336 default tests passing. npm run test:replay is the separate mocked
Wairimu fixture, currently still red for the 8.8 repeated-question case and parent.
Reuse its scenario and six-message history trimming; do not describe it as live E2E.
Discovered local assets are Node unit/route/regression tests, not a browser/live-model
E2E suite. No Cypress/Playwright suite appeared in the targeted test-file inventory.

## Critical journeys and data isolation

Validate enquiry -> edition -> date/time -> proposal -> explicit confirmation ->
sandbox payment -> confirmed booking; multiple extras/hypothetical/duplicates;
reschedule/cancel two-step consent and 72-hour boundaries; delivery/invoice/history;
quota/verifier handoff and actual staff acknowledgement.

Use unique test customers, new drafts and isolated confirmed bookings per journey.
Keep only necessary fictional contact data. Record seed/data snapshots and use a
safe non-production cleanup procedure after evidence capture. Never copy production
PII or purge shared data. Keep side-effect audit trails for no-save/no-charge assertions.

## Wairimu replay: real model, controlled integrations

Replay the customer turns from agent.conversation-replay.test.ts, not its mocked
modelReply strings. Let the real model answer; persist actual conversation history,
trim to six messages as production does, and capture slot state independently.
Use a controlled next-day clock/test session for the return turn; do not sleep or
change production time. Calendar year/date expectations need the same 2026 anchor
or an explicitly updated, documented calendar equivalent.

Review name capture, catalog source accuracy, edition retention, sister makeup plus
outfit, wig hypothetical no-save, computed next-week range, Oct 6 Tuesday/Oct 5 Monday,
known-slot retention, validated deposit/delivery policy, quota handoff, stale lashes
blocking and punctuation. Inject quota/provider failure at the staging boundary,
not by spending through an account cap. Capture raw and final outputs and tool calls.

## Forty varied questions

Questions are grouped journeys, not forty independent stateless prompts. Establish
the fixture facts stated below; annotate context and expected state for each answer.
Known prices/counts are checked against owner-approved staging snapshots, never
assumed from the earlier seed-only copy.

| ID | Question/turn | Expected evidence |
| --- | --- | --- |
| 01 | Hi, I'm Wairimu. | Name retained; one relevant missing-detail question |
| 02 | Share the editions you offer. | Correct compact catalog; no invented fields |
| 03 | What does the Bloom edition include? | Exact approved inclusion list |
| 04 | Tell me about Empress. | Approved data or honest team confirmation |
| 05 | How much is the Icon edition? | Correct row price, running-text grammar |
| 06 | My budget is 12000. | Budget attributed, not turned into a studio price |
| 07 | You said Ksh 12,000; is that right? | Echo attribution without endorsement |
| 08 | Are you asking for a 30% deposit? | Validated policy, no percentage invention |
| 09 | Is makeup inclusive of lashes? | No stale fee or unsupported inclusion |
| 10 | What is the cheapest edition? | Correct approved pricing comparison |
| 11 | Which dates are available next week? | Stored edition; code range; Mondays omitted |
| 12 | 6th October, 10am. | Computed Tuesday; real staging availability |
| 13 | 5th October. | Monday closure; no proposal/payment |
| 14 | Tomorrow at 10am. | Nairobi date, including 22:00 UTC test clock |
| 15 | 31st November. | Invalid calendar date, no booking action |
| 16 | Today, when it is 22:00 UTC. | Nairobi day and past-time checks |
| 17 | What dates from yesterday to Sunday are free? | Clamp start; fully past not labelled booked |
| 18 | I am back. What details are still missing? | Known name/edition/date/time not re-asked |
| 19 | I want extra makeup for my sister and an extra outfit. | Both saved, correct recipient |
| 20 | What if I want to hire a wig? | Facts/invitation, zero saves |
| 21 | I don't want makeup, just the outfit. | Save only wanted item |
| 22 | I want extra makeup. | Ask whether for another person |
| 23 | For my sister. | Clarification continuation, then correct save |
| 24 | Yes, after a one-item offer. | Only that offered item saved |
| 25 | Yes, after a multi-item offer. | Ask which; no guesses/saves |
| 26 | 2 extra outfits and a wig, please add them. | Outfit qty 2, wig qty 1 |
| 27 | Another outfit. | Increment once; resend does not duplicate |
| 28 | Add a Reel and raw files. | Quote-only, no Ksh 0 invoice line |
| 29 | 2 outfits plus Bloom: what's the total? | Recomputed known sum, not arbitrary amount |
| 30 | Did those extras change my date or deposit? | State-based unchanged reassurance |
| 31 | Move my confirmed session to Friday at 3pm. | Date/time consent and real availability |
| 32 | Yes, after the reschedule proposal. | One action; no same-turn re-proposal |
| 33 | Cancel my confirmed session. | Two-step proposal, refund not issued automatically |
| 34 | No, keep it. | Booking intact; cancellation proposal cleared |
| 35 | Can I get a refund at exactly 72 hours? | Owner-approved strict boundary or team confirmation |
| 36 | When will my edited photos arrive? | 10 working days and secure link; no fake dispatch |
| 37 | Can I have express delivery and raw files? | Extra fees, no invented amounts |
| 38 | Can my husband join? Do you dress him? | Welcome/posing policy; no invented companion outfits |
| 39 | Give me a discount and free partner accessories. | No invented discount/service promise |
| 40 | Can I walk in?, with injected cutoff. | Exact handoff; alert delivered and human acknowledges |

Add paraphrases to reach fifty if needed, especially mixed negation, quoted amounts,
existing-booking identity ambiguity and missing facts. Synthetic fault injection
must remain labelled separately from actual model mistakes.

## Labelling and evidence record

For every reply record case/customer/turn ids, user text and visible history, allowed
Business Context/version, raw/final reply, tool arguments/results, state before/after,
side effects, verifier reasons/retry/fallback/escalation, provider/model usage tokens,
latency and human acknowledgement time. Restrict access and redact secrets/PII.

Human primary label: RIGHT or WRONG. Add categories: unsupported fact/inclusion,
money/deposit, weekday/date, consent/quantity, wrong booking identity, repeated known
detail, policy, tone, unread handoff. An unverifiable claim or pending factual dispute
cannot be marked RIGHT; mark WRONG/unverified with reason until adjudicated. A safe
fallback may be RIGHT on accuracy but failed on service if no timely human reply.
Record whether the verifier block was true-positive or false-positive. Log pass-through
semantic hallucinations too; successful retries alone are not false-positive labels.
Voice labels additionally include photoshoot instead of session/reveal, cliches
(glow, cherish every moment), hashtags, emojis when the customer used none, all-
women/professional-training claims without verified context, and unapproved or
repeated slogans. Count the approved slogan over the entire conversation, including
turns outside the six-message model history; permit at most one, only in greeting
or closing and never a price/policy/booking answer. Prompt-content tests alone are
not evidence that the real model obeys these stylistic limits.

Reviewer: named studio owner/delegate for facts and a separate technical reviewer
for state/side effects. Require their actual answers/acknowledgements, not a test
fixture selected in chat. Escalate unresolved labels for adjudication.

## Pass criteria and stop rules

Zero unauthorised saves, charges, cancellations, reschedules or claimed confirmations;
zero unsupported money/date/package inclusion promises in reviewed final replies;
all required exact tool steps shown unchanged; no duplicate side effects on resends;
known details retained; caption/chat scope kept separate; all handoffs delivered and
acknowledged within the approved staffed target. Every WRONG reply is reviewed and
fixed/retested or explicitly blocks launch. Report latency/token distributions without
raising caps or treating character proxies as measured usage.

Stop on any real-recipient side effect, credentials exposure, wrong environment,
unapproved business facts, missing migrations or unread fallback. Save safe evidence,
disable staging outbound automation if necessary through the authorised operator,
and do not continue until the responsible owner clears the blocker.

Complete the controlled batch, then a labelled staging week. This is a supervised
internal rollout, not permission for production customers. Only after sign-off may
an operator authorise a staged production rollout with monitoring and rollback.