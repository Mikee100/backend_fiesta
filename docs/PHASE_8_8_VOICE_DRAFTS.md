# Phase 8.8 voice drafts: approval first

8.8 implementation and text approved for a separate commit. Fixed replies,
complete BRAND/VOICE blocks and final slogan guard are implemented locally with
tests. No staging deployment, live-model certification or customer rollout.
The client has not clarified whether generic content means concierge replies or
a separate caption generator. Do not insert her full content brief into chat.
If captions are separate, use a separate prompt file after that scope is confirmed.

## Eight customer reply drafts

These are conditional examples, not live studio or availability confirmations.
Only use each draft when its listed Business Context or successful tool facts
exist. No package facts have been confirmed by the owner; example prices must
come from validated application context rather than the voice instructions.

### 1. Welcome, name and edition choice

No name/session context yet:
"Welcome to Fiesta House Maternity. What kind of session are you planning?"

Required context: customer stated Wairimu; maternity enquiry; edition unknown:
"Thank you, Wairimu. Which edition would you like to consider for your maternity session?"

Required context: Wairimu and THE BLOOM known; ask this ONLY if date is unknown:
"The Bloom edition it is, Wairimu. What date would suit you?"

These are conditional branches of one collection example, not three questions to
send together. If date/time are already known, ask only the next missing detail;
if no collection detail is missing, do not manufacture a question. All-caps edition
names remain headings/catalog labels; running text uses Bloom/the Bloom edition.

### 2. Multiple extras saved

Required context: successful saves for extra makeup for the sister and one extra
outfit; balance-not-deposit policy; package/date unchanged. Never use on a question
or a failed save. Partial outcomes retain the explicit saved/unsaved wording.

"Noted for your session: extra makeup for your sister and an extra outfit. Extras go to the session balance, not the deposit."

Only when the customer's message asks whether the booking/edition/date was changed,
and tool evidence confirms it was not, append:
"I have not changed your edition or date."
Use shared ADDON_NOTED_PREFIX and the shared conditional unchanged-detail constant;
test actual rendered replies with isAddonListFollowUp and related consumers.

### 3. Hypothetical wig question

Required context: styled wig hire unit price Ksh 4,000 supplied in Business Context;
no choice or save occurred. If the price is absent, ask the team rather than infer.

"Styled wig hire is Ksh 4,000 each. Would you like to add it to your session?"

### 4. Availability and deposit step

Required context: a successful slots check returned 10:00 on 2026-10-06 for THE
BLOOM; code computed Tuesday. This is a check, not a confirmed booking or hold.

"Tuesday, 6 October at 10am is available for the Bloom edition. Would you like to go ahead with that time?"

Required context: propose_booking succeeded for THE BLOOM, 2026-10-06, 10:00,
deposit Ksh 2,000 validated by getDepositForPackage(), and code computed Tuesday
from that date in Africa/Nairobi. No payment prompt sent yet. This remains backend-owned;
any approved wording change must go through the proposal builder and its matcher.

"Your details for the Bloom edition are ready for Tuesday, 6 October 2026 at 10:00. The deposit is Ksh 2,000. Reply yes if you would like me to send the M-Pesa prompt. Your booking is confirmed once the deposit is received."

The two branches correspond to different successful tool states. Availability is
not confirmation; replying yes authorizes the next payment step, not a claim of
successful payment. Do not expose the internal term "booking proposal" or promise
a customer reservation at the availability stage. Existing temporary draft slot-
hold mechanics stay unchanged; the confirmed booking remains conditional on paid
deposit. If deposit validation fails, ask the team rather than quote seed money.

### 5. Photo delivery

Required context: established 10-working-day policy and secure download-link
delivery. Do not imply the session happened or that a link was already sent.

"Edited photos are ready 10 working days after your session. We share them through a secure download link."

### 6. Unknown answer / reassurance

Required context: the requested fact is absent or unverified. No new feature,
inclusion, price, deadline or successful save may be inferred. No response-time
promise is added; the operational handoff owner is still unassigned.

"The team will confirm that for you."

### 7. Husband or partner joining

Required context: the supplied companion policy says partners/children may join
and the team guides poses. Sources: existing getStudioPolicyReply and local FAQ
question "Can my partner and other children join the shoot?". This is not a new
owner attestation. Do not infer companion outfits, accessories, grooming or fees.

"Your husband is very welcome to join your maternity session. We'll guide poses that include everyone."

Use partner instead of husband if that is the customer's word; do not infer a
relationship or change the scope of the supplied companion policy.

### 8. Closing after a completed booking

Required context: a verified successful deposit/payment record and confirmed
booking for Tuesday, 6 October 2026 at 10:00. The weekday comes from code. Do not
use this on a pending proposal, STK prompt, verbal yes, or unverified receipt.

"Your booking is confirmed for Tuesday, 6 October at 10am. We're looking forward to welcoming you to Fiesta House Maternity."

The only supplied slogan is "Where Every Mother Becomes Iconic." It is optional,
at most once per conversation and only in a greeting or closing, never in a price,
policy or booking answer. No other slogan may be invented. The all-women,
professionally trained team claim still needs owner confirmation before launch;
the BRAND rule requires verified Business Context and relevance before use.

Count rationale: merging greeting/name alone and adding three missing examples
would make ten. This eight-scenario set also pairs name capture with edition choice,
and availability with the deposit step, keeping every requested case covered.

## Fixed replies: separate before/after proposals

| Surface | Current wording | Proposed wording |
| --- | --- | --- |
| Business introduction | Welcome to Fiesta House! We are a boutique luxury photography studio in Parklands, Nairobi, specialising in maternity, newborn, and family portraiture. We take care of everything... | Welcome to Fiesta House Maternity. What kind of session are you planning? |
| Edition selection | THE BLOOM is a lovely choice. What date are you considering? Once you have a day in mind, I can check the available times for you. | The Bloom edition it is, Wairimu. What date would suit you? Only if date is unknown; name only if known. |
| Add-on acknowledgement | Noted for your session: ... I have not changed your package or date. What would you like to confirm next? | Keep shared Noted for your session: ... plus balance policy; omit the defensive unchanged line and generic closing by default. |
| Add-on unchanged reassurance | I have not changed your package or date. | Shared I have not changed your edition or date. Only if asked and supported by tool evidence. |
| Checked availability | 2026-10-06 is Tuesday. 10:00 is available for THE BLOOM. Would you like me to prepare a booking proposal? | Tuesday, 6 October at 10am is available for the Bloom edition. Would you like to go ahead with that time? |
| Backend deposit proposal | Great, I can hold THE BLOOM for 2026-10-06 at 10:00. The deposit is KSH 2000. If that works for you, just reply yes and I'll send the M-Pesa prompt. | Your details for the Bloom edition are ready for Tuesday, 6 October 2026 at 10:00. The deposit is Ksh 2,000. Reply yes if you would like me to send the M-Pesa prompt. Your booking is confirmed once the deposit is received. |
| Booking-process balance line | Pay the remaining balance after the shoot by M-Pesa or cash. | Pay the remaining balance after your session by M-Pesa or cash. |
| Booking-process delivery line | Edited photos are ready 10 working days after the shoot and shared through a secure download link. | Edited photos are ready 10 working days after your session and shared through a secure download link. |
| Post-session heading | After the shoot: | After your session: |
| Raw-file quote | Raw files are quoted by package tier. ... our team can confirm the exact quote... | Raw files are quoted by edition. The team can confirm the fee for yours. We share them through a secure download link. |
| Cutoff | Thank you for your patience. A member of our team will pick this up with you shortly. | Unchanged: separately approved in 8.7; requires staffed handoff before launch. |
| Empress detail hold | The team will confirm the exact inclusions for you. | Unchanged until owner data is verified. |
| Booking-process closing | Would you like to check available dates? | Unchanged. |
| Companion policy | Your partner and children are welcome to join your maternity session. We will guide poses that include everyone beautifully. | Your husband is very welcome to join your maternity session. We'll guide poses that include everyone. Use the customer's own relationship word. |
| Unknown-answer fallback | Let me have the team confirm that exactly for you. | Keep the verifier failure fallback unchanged; the warmer unknown-answer example is for a missing-context reply, not an automatic replacement. |
| Completed-booking closing | No single generic closing may assert a completed booking without state. | Your booking is confirmed for Tuesday, 6 October at 10am. We're looking forward to welcoming you to Fiesta House Maternity. Requires confirmed booking AND verified payment. |

These show the approved before/after changes. The business-introduction current cell is an
excerpt; it is not used as a snapshot of the full old reply.
Preserve shared ADDON_NOTED_PREFIX, ADDON_UNCHANGED_REPLY, catalog heading and
invitation constants; update consumers with any approved copy change. Add matcher
tests built from actual rendered replies. Teach post-session triggers both shoot
and session forms when changing the heading. Proposal/payment/cancellation
consent matchers must still recognise the exact backend text. Do not let voice
rewrite money, saved outcomes or confirmed actions.

## Small proposed runtime blocks

BRAND (draft):
```text
BRAND: Fiesta House Maternity's pillars are Luxury, Safety, Convenience and Comfort. Mention the all-women, professionally trained team only when relevant AND verified in Business Context. The only slogan is "Where Every Mother Becomes Iconic." Use it at most once per conversation, only in a greeting or closing, never in a price, policy or booking answer.
```

VOICE (draft):
```text
VOICE: Brief, calm sentences. Say session or reveal, never photoshoot, in your own words. No cliches (glow, cherish every moment) or hashtags. No emojis unless the customer uses them. Ask one question only for a missing detail; keep known facts. Facts come from Business Context or successful tools, stated plainly. Use the Bloom edition/Bloom in running text; capitals for headings. Correct errors briefly.
```

The full client brief takes priority over the earlier 450-character target. The
implementation replaces D1-D3 and D6 rather than appending those blocks. The
unknown-answer example is integrated into C2; eight full examples remain here,
not in the runtime prompt. Source-rendered before/after size must be recorded
before approval/commit. No cap, tool gating or caching changes belong in 8.8.
Source-rendered result, fixed 8.7 clock, empty context, WhatsApp, pricing included:
before 15,919 characters; after 15,595; net -324. BRAND 357, VOICE 407, combined
764 characters after removal of the stray semicolon. These are character counts,
not provider token measurements.
No full runtime examples are proposed until approval. If needed, keep only two
short contrasts: unknown fact -> team confirmation; known date -> do not ask again.

## Implementation gate and scope limits

The replay injects a repeated name/edition question despite known slots. A narrow
code-owned guard replaces only recognised repeated collection questions during
collecting_slots, asking for the next missing date/time or whether to continue.
Protected draft steps, explicit correction/recommendation requests and exact tool
outputs bypass it. The original mock reply is unchanged; real-dispatch checks and
replay verify the guard rather than crediting the prompt alone.

The slogan now has a final-output guard. It is stripped from replies containing
price/deposit/date/policy markers or not recognisable as greeting/closing. Quotes
and trailing punctuation after the original slogan period are normalised.
CustomerMemory.keyInsights holds a namespaced system marker, not a customer fact.
An atomic conditional update claims that marker once, surviving trim/restart and
concurrent requests. Scope is the current active UnifiedConversation.sessionId;
without one, it is the conservative customer/platform thread (no automatic reset).
Stored outbound messages catch older slogan uses. State failure suppresses this
optional slogan. Claim occurs before delivery; failed delivery may consume it,
which is safer than repeating it. No new schema column or fake chat message is used.
These are mocked persistence tests, not PostgreSQL concurrency certification.

Other stylistic bans and unsupported team/inclusion claims remain prompt rules,
not a semantic truth guarantee. Staging must count slogans across the entire
conversation and label inappropriate placement, invented slogans, unverified team
claims, cliches, hashtags and disallowed emojis. The conservative pattern guard
does not certify every possible verbal policy paraphrase.

During validation an older static-builder fixture attempted an unmocked edition
lookup, and the new information-route fixture initially omitted its appointment
lookup mock. Both boundaries are now explicitly mocked and tests rerun. Neither
established live data accuracy. No staging deployment or live-model run occurred.

Owner answers, stale lashes-vector removal, rotated credentials/safe dev DB,
migration baseline/application and named staffed handoff ownership still block
customer rollout. The short BRAND/VOICE blocks do not verify business data or
eliminate semantic hallucinations. A labelled staging week remains necessary.