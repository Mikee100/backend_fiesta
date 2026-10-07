# Emoji policy review

Status: warm density implemented locally; final copy awaiting review. No commit
or deployment performed. Existing unrelated and prior-phase changes are retained.

## Policy

- Fourteen distinct whitelist candidates: white heart U+1F90D, maternity U+1F930,
  calendar U+1F4C5, location U+1F4CD, check U+2705, camera U+1F4F8, ribbon U+1F380.
  Added cherry blossom U+1F338, bouquet U+1F490, baby U+1F476, dove U+1F54A
  with U+FE0F, party popper U+1F389, yellow heart U+1F49B and smiling face U+1F60A.
  Sparkles, pink hearts, skin-tone variants and other graphemes remain excluded.
- EMOJI_LEVEL in emoji-policy.ts is the single density control, default 'warm'.
  Restrained caps are one per message and two in greetings/closings; warm caps
  are two and three. These are caps, not quotas; templates currently add one.
- Warm adds name capture, add-on acknowledgement, extras questions, time options,
  reminders, delivery, thank-you and location. It does not require customer emojis.
  Existing template boundaries decorate these categories; model suggestions are
  sanitized using the same settings and whitelist. Model guidance derives from
  the level, so changing the constant also changes the prompt.
- Sentence/line ends remain eligible. Warm additionally permits line-start emojis
  in short lists of two or three non-empty lines, each at most 100 characters.
  No emoji rows or arbitrary mid-sentence placement.
- Financial amounts, prices, deposits, balances, invoices and receipts remain plain.
  Failures, cancellations, refunds, complaints, escalations, team-confirmation text
  and replies to a negative-scored customer message remain plain.
- Restrained retains customer-tone mirroring outside greetings, closings and
  confirmations. Warm permits decoration without mirroring.
- Model emojis are suggestions, sanitized in formatting, verifier processing and
  the final reply step. Deterministic routes use REPLY_EMOJI; suppressed decoration
  returns the original deterministic text. Financial confirmations are not rewritten.
- Recent outbound text plus a conversation-scoped CustomerMemory.keyInsights marker
  prevents consecutive reuse. Compare-and-set preserves other memory markers and
  suppresses conflicting concurrent suggestions. Reads/claims failing suppress the
  optional emoji. Claims occur before delivery and can be consumed by a failed send.
  Immediate reuse is blocked at both levels; warm permits reuse after one different
  reply, including a plain reply. The existing durable check already enforces this.
- The existing six-message matcher history is normalized before routing. Reusable
  history matchers also strip assistant emojis; customer emojis remain available
  for mirroring. Money parser expressions are unchanged.
- Logs use emoji=stripped with financial, failure_or_handoff, team_confirmation,
  negative_sentiment, formal_tone, placement, maximum, not_whitelisted,
  consecutive_repeat, reply_type, length, state_unavailable or state_conflict reasons.

## Copy for approval

In the previews below, bracketed Unicode values represent the rendered emoji.
All emojis remain optional under sentiment, financial-context and repetition rules.

These are independent policy-processed previews, not claims about a live booking,
availability, customer profile or fulfilled delivery. They are not consecutive turns.

1. Welcome to Fiesta House Maternity. [U+1F90D] What kind of session are you planning? [U+1F930]
2. Friday, 9 October is open. [U+1F4C5] Which of these times suits you?
3. The Muse it is. [U+1F930] What date would suit you?
4. Nice to meet you, Maryanne. [U+1F338]
5. Noted for your session. Extras go on the balance, not the deposit.
6. Would you like to add any extras? [U+1F476]
7. Which of these times suits you? [U+1F4C5]
8. We are at Diamond Plaza Annex, 4th Avenue, Parklands. [U+1F4CD]
9. Edited photos are ready in 10 working days. [U+1F4F8]
10. You're welcome. [U+1F60A] We can't wait to meet you.

Preview 5 stays entirely plain because the unchanged financial exclusion applies
to the whole reply, not just the money sentence. No financial/invoice block changes.

## Verification

Warm focused tests: six passed. Full default suite: 507 passed, five failed because
fixtures expect 6 October 2026 to be future while the current date is 7 October.
These unrelated date assertions were not changed. Existing mocked replay: 16 passed,
zero failed, three existing TODOs. TypeScript passes. Focused regressions cover
forbidden contexts, budgets, grapheme stripping (ZWJ/flags/keycaps), placement,
mirroring, persisted/concurrent repetition, state failure, money-adjacent emojis,
matcher compatibility with all fourteen whitelist graphemes and two emoji positions,
mocked model/template pipeline, logging, length and encoding.
The new policy module uses ASCII source and Unicode escapes, not pasted glyphs.
Editor diagnostics pass. Encoding scan finds no corrupted characters in added
lines; pre-existing fixture characters match HEAD unchanged. The policy module
also passes a strict whole-file ASCII check. All ten previews were generated
through the actual policy functions without database or provider operations.

The current warm prompt render measured 16,687 characters versus 16,212 using the
old no-emojis rule: +475 characters, not tokens.
No real-provider token measurement or first-week staging-density evaluation occurred.

Tests redirected DATABASE_URL to an unreachable local endpoint and mocked external
operations. No live profile/database inspection, payment, Calendar action, schema
migration, credential edit or outbound customer message was performed by the agent.
Mocked concurrency is not PostgreSQL or delivery-order certification. Assess the
sentiment heuristic and suppression logs during staging; it is not a full emotional
classifier. Review and commit this phase separately from prior pending work.
Real Android/iPhone rendering has not been checked; that requires actual devices.