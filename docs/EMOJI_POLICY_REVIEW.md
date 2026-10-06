# Emoji policy review

Status: implemented locally; whitelist and copy awaiting client approval. No commit
or deployment performed. Existing unrelated and prior-phase changes are retained.

## Policy

- Seven distinct approved candidates: white heart U+1F90D, maternity U+1F930,
  calendar U+1F4C5, location U+1F4CD, check U+2705, camera U+1F4F8, ribbon U+1F380.
  Sparkles, pink hearts, skin-tone variants and other graphemes are not approved.
- Maximum one per message, or two distinct sentence/line-end emojis in a greeting
  or closing; no rows, no mid-sentence placement. Template routes currently add one.
- Financial amounts, prices, deposits, balances, invoices and receipts remain plain.
  Failures, cancellations, refunds, complaints, escalations, team-confirmation text
  and replies to a negative-scored customer message remain plain.
- For a customer using no emojis, only greetings, closings and confirmations are
  eligible. Package selection is decorated only when the customer uses an emoji.
- Model emojis are suggestions, sanitized in formatting, verifier processing and
  the final reply step. Deterministic routes use REPLY_EMOJI; suppressed decoration
  returns the original deterministic text. Financial confirmations are not rewritten.
- Recent outbound text plus a conversation-scoped CustomerMemory.keyInsights marker
  prevents consecutive reuse. Compare-and-set preserves other memory markers and
  suppresses conflicting concurrent suggestions. Reads/claims failing suppress the
  optional emoji. Claims occur before delivery and can be consumed by a failed send.
- The existing six-message matcher history is normalized before routing. Reusable
  history matchers also strip assistant emojis; customer emojis remain available
  for mirroring. Money parser expressions are unchanged.
- Logs use emoji=stripped with financial, failure_or_handoff, team_confirmation,
  negative_sentiment, formal_tone, placement, maximum, not_whitelisted,
  consecutive_repeat, length, state_unavailable or state_conflict reasons.

## Copy for approval

In the previews below, bracketed Unicode values represent the rendered emoji.
All emojis remain optional under sentiment, financial-context and repetition rules.

Greeting:
Welcome to Fiesta House Maternity. [U+1F90D] What kind of session are you planning?

Date available (only after a successful availability check):
2:00 PM on Friday, 9 October 2026 is available for the Muse edition. [U+1F4C5] Would you like to go ahead with that time?

Package chosen (mirrored customer tone only):
The Muse it is. [U+1F930] What date would suit you? You can see everything included here: https://www.fiestahousematernity.com/session-packages

Standalone payment-confirmed preview:
Payment received. [U+2705] Your Muse session is confirmed.
This does not replace or decorate the existing payment/invoice block with amounts,
receipt, invoice number or balance. That full financial block remains exact and plain.

Closing:
You are welcome. [U+1F90D] I am here if you need anything else.

## Verification

Final default suite: 472 passed, zero failed. Existing mocked replay: 15 passed,
zero failed. TypeScript and editor diagnostics pass. Focused regressions cover
forbidden contexts, budgets, grapheme stripping (ZWJ/flags/keycaps), placement,
mirroring, persisted/concurrent repetition, state failure, money-adjacent emojis,
matcher compatibility, real model/template pipeline, logging, length and encoding.
The new policy module uses ASCII source and Unicode escapes, not pasted glyphs.

VOICE replacement adds 122 characters to the rendered system prompt. One fixed
render measured 16,211 -> 16,333 characters; these are character counts, not tokens.
No real-provider token measurement or first-week staging-density evaluation occurred.

Tests redirected DATABASE_URL to an unreachable local endpoint and mocked external
operations. No live profile/database inspection, payment, Calendar action, schema
migration, credential edit or outbound customer message was performed by the agent.
Mocked concurrency is not PostgreSQL or delivery-order certification. Assess the
sentiment heuristic and suppression logs during staging; it is not a full emotional
classifier. Review and commit this phase separately from prior pending work.