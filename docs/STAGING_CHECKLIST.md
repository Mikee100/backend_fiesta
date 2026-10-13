# Staging launch checklist

Planning only. No staging execution or production/customer rollout is authorised.
Use the detailed STAGING_AI_TEST_PLAN.md for the exact forty questions and evidence.

## Prerequisite assignment matrix

### Internal engineering tasks

| Task | Owner | Target Timeline | Status |
| :--- | :--- | :--- | :--- |
| **Rotate exposed credentials outside chat** (Supabase, M-Pesa, Groq/Gemini, WhatsApp, Pinecone) | Tech Lead / Developer | Day 1 | Pending |
| **Model & provider decision on paid tier** (Select Groq paid or Gemini pay-as-you-go; configure billing & hard cap) | Tech Lead / Developer | Day 1 | Pending |
| **Send owner the 2-part briefing messages** (Part A: Staffing decision; Part B: Factual questionnaire with deadline) | Tech Lead / Developer | Day 1 | Pending |
| **Create isolated dev/staging PostgreSQL DB & baseline migrations** (no shared DB / no schema push on live) | Tech Lead / Developer | Day 2 | Pending |
| **Clean / re-ingest Pinecone index** (remove stale lashes vector; verify price no longer retrieved) | Tech Lead / Developer | Day 2 | Pending |
| **Implement & test kill switch** (`AI_AUTOMATION_ENABLED=false` tested end-to-end to dashboard inbox) | Tech Lead / Developer | Day 2 | Pending |
| **Execute 40-question staging plan on isolated environment** | Tech Lead & Assistant | After dependencies clear | Blocked |

### External dependencies (Timeline depends on external parties)

| Dependency | Required From | Impact if Delayed | Status |
| :--- | :--- | :--- | :--- |
| **Duty concierge & refund owner assignment** (Message 1A) | Studio Owner | Cannot promise "shortly" in customer copy; handoffs unmonitored | Awaiting owner |
| **Review & sign off factual answers** (Message 1B) | Studio Owner | Unconfirmed questions must remain deterministic team-confirm replies | Awaiting owner (by target deadline) |
| **Safaricom Daraja production C2B/STK review** (Paybill/Till live approval) | Safaricom / Studio Owner | Staging runs on sandbox; live payments blocked until Safaricom approves | In progress (1–3 wk lead time) |

## Prerequisites & operational definitions

- **Credentials & Environment Isolation:** Rotate exposed credentials outside chat and provide staging-scoped secrets through the approved secret store. Never paste credentials into agent tools. Fictional customers, sandbox payments, and isolated Google Calendar only.
- **Provider & Paid Tier Selection:** Pick a specific paid model tier (e.g. Groq paid tier or Gemini 2.5 Flash pay-as-you-go) with a hard monthly budget cap before running staging. Free-tier Groq/Gemini rate limits distort response timings and force artificial failover cascades.
- **Latency SLAs & Stop Thresholds:**
  - Target: median reply under 10 seconds.
  - Hard stop: no single turn taking > 60 seconds. A turn exceeding 60 seconds triggers an immediate investigation of provider timeout / cooldown.
- **Kill Switch & Outbound Mute:**
  - Mechanism: `AI_AUTOMATION_ENABLED=false` environment flag in Render / local `.env`.
  - When false, all incoming turns immediately route to human-handoff text (`"The studio team will help you shortly on 0720 111928."`) and generate an escalation without invoking any LLM or scheduling background automation.
  - **Coexistence & Dashboard Inbox:** A WhatsApp number connected to Meta's WhatsApp Cloud API generally cannot simultaneously be used on the standard mobile WhatsApp Business app (coexistence restrictions). The kill switch must therefore route conversations to the staff dashboard/inbox, and this path must be tested once before staging.
- **Production M-Pesa (Daraja) Readiness:**
  - Production requires Safaricom Business Administrator KYC, production consumer key/secret, registered Till/Paybill, and Daraja STK Push activation.
  - Safaricom lead times can take 1–3 weeks; initiate immediately while staging progresses.
- **Refund Policy & Escalation Ownership:**
  - Define named refund officer, method (Daraja reversal API or M-Pesa business portal), and SLA (e.g. within 2 business days).
  - Escalation reader: Name the primary duty studio concierge, backup, and staffed hours (e.g., 8:00 AM – 7:00 PM Tuesday–Sunday). Agree on a realistic acknowledgement target before promising "shortly" in customer-facing replies.
- **Customer Data Protection & Privacy:**
  - Data collected: phone number, customer name, appointment dates, conversation logs.
  - Retention limit: 90 days for raw WhatsApp interaction messages is an initial engineering proposal; booking and financial records must be kept longer for accounting, tax, and dispute resolution.
  - Note: This is an operational baseline, not legal counsel; consult qualified Kenyan legal advice for formal Kenya Data Protection Act 2019 compliance.
- **Cost & Token Tracking:**
  - Measure actual input/output tokens per session during staging to verify estimated monthly cost (target: < KES 50 per completed booking flow).
- **Rollback & Failsafe Plan:**
  - If week one shows unhandled errors or reader backlog, toggle `AI_AUTOMATION_ENABLED=false`.
  - All existing bookings and payments in PostgreSQL remain intact; incoming turns route to human staff via the dashboard inbox.

## Minimal Day-1 Launch Bar (Scope Reduction)

To avoid launching an overly broad surface area:
1. **Core flow only in automated mode:** Package browse (`https://www.fiestahousematernity.com/session-packages`), date/time lookup & booking, deposit payment proposal via M-Pesa, standard reschedule, and cancellation proposals.
2. **Deterministic handoff to team for all unconfirmed/complex queries:**
   - Returning-client discounts, custom edition upgrades after deposit, family styling/wardrobe, lashes/hair prep details, bespoke requests.
3. **Controlled rollout:**
   - 5 to 10 invited test clients or friends of the studio in week one.
   - 100% human observation: named duty reader reviews every turn as it occurs.
   - Daily end-of-day review converting any friction into automated regression fixtures.

## Execute on isolated staging

- Record commit, model/provider, prompt, database and retrieval-index versions.
- Replay Wairimu's customer turns using the real model, not mocked modelReply strings.
  Keep six-message trimming and a controlled next-day return; audit saved slots and
  side effects. Use a matching fixed calendar fixture or documented equivalent dates.
- Run the forty varied questions in STAGING_AI_TEST_PLAN.md as contextual journeys:
  pricing, dates, rescheduling/cancellation, extras, policies, odd requests and handoffs.
- Use fictional test customers, isolated calendars, sandbox payments and approved
  internal channels. No production number, live customer charge/refund or unapproved
  database/Pinecone operation.

## Label and review

- Label every final reply RIGHT or WRONG against owner-approved facts and tool/state
  evidence; unverified claims are not RIGHT. Record reason and adjudication owner.
- Capture raw/final reply, context/history, tool arguments/results, state changes,
  side effects, provider tokens, tool rounds, verifier retries and latency.
- Label verifier blocks true/false positive; inspect semantic hallucinations that pass.
- Check slogan at most once, correct placement/punctuation, brief adherence and no
  repeated known details. Verify all price/consent/provisional-until-paid boundaries.
- Staff read EVERY conversation in week one; the named duty reader owns every fallback
  through actual acknowledgement and a human reply, including suppressed repeat alerts.

## Stop and sign off

- Stop on wrong environment, exposed secret, unauthorised save/charge/change, false
  confirmation, unsupported fact, missing migration, unread handoff, or latency > 60s. Preserve safe
  evidence and have the authorised operator disable outbound automation if needed.
- Fix and rerun failed cases; do not increase caps from character or mocked counts.
- Owner/delegate signs facts; technical reviewer signs state/side-effect safety;
  duty reader signs handoff coverage. Only then may an operator approve a small
  watched real-customer rollout. All open prerequisites still block that step.

---

## Ready-to-send messages

### Message 1A: Studio Staffing & Operational Decision (Send First)

*Send this short message first to establish who monitors escalations:*

> Hi! We're setting up the WhatsApp booking assistant for Fiesta House. Whenever a client asks something custom or needs human help, the assistant hands them off to the team.
>
> Could you confirm:
> 1. Who on the studio team should receive alerts when a customer needs human assistance or has a refund question?
> 2. What are their active staffed hours (e.g. 8:00 AM – 7:00 PM Tuesday–Sunday)?
> 3. What is our target response time for following up with them?
>
> Once we have this, we can set up the staff notification alerts and make sure no customer request gets missed. Thank you!

---

### Message 1B: Studio Fact Verification (Send Second, with Deadline)

*Send this second with a suggested deadline date:*

> Hi! To make sure the assistant gives accurate answers and stops guessing on client questions, could you help confirm these details for us?
>
> **Preparation & Studio Policies:**
> 1. **Lashes:** Are lashes included in the makeup for every package, or are they an extra charge? If extra, what is the price?
> 2. **Hair & Wigs:** Does each session include basic hair styling? Are clients welcome to bring their own hair or wigs ready for styling?
> 3. **Outfits & Gowns:** How do clients choose their outfits — in the studio during the session, from photos beforehand, or both? Are they allowed to bring personal outfits?
> 4. **What to Bring:** What should clients wear or carry to the studio? (Our current note mentions bringing baby items and wearing a black bra and panties — is that the studio's official guidance?)
> 5. **Parking:** Is there dedicated parking available at the studio for clients?
> 6. **Contact Email:** Is info@fiestahouseattire.com still the studio's official email address?
>
> **Editions & Pricing:**
> 7. **The Power Suit:** What is the Power Suit look, and which packages include it without extra charge?
> 8. **Package Inclusions:**
>    - The Empress: What are the exact inclusions (hours, edited photos, styled wigs, photobook, Reel)?
>    - The Bloom: Is it 1.5 hours with 6 photos?
>    - The Legend: Does it include 1 styled wig? (The website omits it, but our notes mention one).
> 9. **Deposit:** Is the booking deposit Ksh 2,000 for every edition, or does it vary by package?
> 10. **72-Hour Policy:** If a client reschedules or cancels at exactly 72 hours before their session, is rescheduling free and is the deposit refundable?
> 11. **Discounts & Upgrades:**
>     - Is there an approved discount for returning clients (flat rate or percentage)?
>     - If a client upgrades their edition after paying the deposit, how is the price difference handled?
> 12. **Partner & Family:** Are outfits and styling provided for partners and children, or only for the expecting mother?
> 13. **Team Description:** Is the phrasing "all-women, professionally trained team" approved for use?
>
> Could you reply by **[Day, Date, e.g., Friday 5 PM]**? Any question you’re unsure about or want to keep flexible, just let me know and the assistant will continue passing that specific question to the team!

---

### Message 2: Content Scope Clarification

*Copy and send to clarify the separate content request:*

> "When you say generic content, do you mean the WhatsApp chat replies, or a separate social media caption and marketing content generator?"