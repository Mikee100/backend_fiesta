# Phase 8.6 output verifier

Final LLM-generated customer text is checked before return. Backend-built calendar,
cancellation, policy and action-guard replies remain deterministic and bypass the
model verifier. Leading stray dashes/punctuation are removed without regeneration.

Checks reject unsupported Ksh/KES/Shs amounts, percentage deposits, deposit amounts
outside validated deposit facts, any lashes price, retired package names used as
packages, incorrect weekday/date claims and mismatched numeric edition durations.
Money facts come from validated package rows, configured positive add-on prices
and successful financial tool results, not retrieval text. Package rows are read
only when the candidate contains money, a percentage-deposit claim or an edition-duration claim. Pending or
conflicting duration facts are withheld, not resolved by selecting a source winner.

On violation, one tool-free corrective completion is requested with supplied facts
and the offending draft explicitly quoted as data. No correction tool calls or
new unverified action claims are executed/accepted. A valid correction is sent.
Repeated violation, empty correction or provider failure produces:
"Let me have the team confirm that exactly for you."

The repeated-failure path escalates with capped original/regenerated text, logs
`[AGENT_FLOW] verifier=blocked reason=...`, and marks output_verifier_failed.
Completed corrective calls and token counts are included in AGENT_USAGE. Escalation
storage failure does not permit unsafe text to escape. Regeneration never repeats
earlier booking/payment/reschedule side effects.

## Approval evidence and amount policy

Each original fault has a named test: 30% deposit/Ksh 4,500 for Bloom, lashes KSh
500, 6 Oct Monday, five-hour Bloom, standard makeup package, and leading dash.
The dash is cleaned without a retry; numeric/name/calendar faults are blocked.

The allowed set contains positive configured add-on unit prices, positive package
prices from application rows, deposits validated by getDepositForPackage(), and
successful financial tool figures. It does not import arbitrary retrieval amounts.
Bare deposit numbers are checked against validated deposits too. Counts/times are
not currency, and "our standard process" is not a retired edition name.

Customer-provided amounts are not added globally to that set. Clause-level "you
said/quoted/mentioned/reported", "your budget", or "another/other studio" and
"competitor" attribution permits an amount supplied in the current customer
message. Bare explicit budgets are supported. This repeats a report without
endorsing a studio price; a following studio-price clause must independently pass.
Named third-party shorthand and complex attribution remain conservative rather
than inferred. Questions quoting percentages/lashes still meet those strict bans.

Simple itemized arithmetic uses integer quantities 1-50 and known positive unit
prices: multiplication, +/plus/and, then =/costs/come to/total. Package-plus-extras
and numeric trusted units are supported. The total is recalculated; wrong totals
are blocked even if the resulting number happens to be another known price.
Unpriced items cannot manufacture a zero-priced total. Arbitrary prose amounts,
discounts and complex expressions are not automatically blessed as computed sums.

Exact backend booking/reschedule proposals and successful payment/reschedule confirmations are pinned to the successful tool
result, not regenerated model paraphrases. Canned replies also bypass verification.
Correction tool calls and unverified action claims are refused. The second reply
is verified using the same facts. Repeated failures use the exact fallback above.

Escalations include capped customer message and original/regenerated draft text.
A bounded, process-local per-customer limiter permits one escalation per ten
minutes, matching the outage cooldown interval. Repeated blocked replies still
produce the fallback and reason logs, but suppress duplicate alerts. This is not
a distributed cross-instance limiter. The payload is evidence, not executable text.

Logs distinguish percentage_deposit, unknown_amount, deposit_mismatch,
computed_total_mismatch, lashes_price, weekday_mismatch, invalid_date,
retired_package, duration_mismatch, regeneration_failed and empty_regeneration.
Passed/corrected/suppressed outcomes and AGENT_USAGE verifierChecked/verifierRetries/correctionChars
allow staging counts. A true false-positive rate still requires human-labelled
staging review; successful regeneration alone is not a false-positive label.
The correction system message is compact, but the retry also repeats the existing
prompt/history/tool context. Replay counters are simulated, not live token costs.
No cap change is justified by this mocked replay.

Measured mocked replay: twelve customer turns, one corrective completion, 1,019
characters in the added correction system message, eight total mock completions.
That is one retry per twelve turns, not a real-world regeneration or false-positive
rate. The fixture's token totals are synthetic. The actual retry input also repeats
the existing context and offending assistant draft; its cost exceeds the added
system-message length. Live usage/staging labels are needed before 8.7 decisions.

## Limits and prerequisites

This is a scoped conservative text verifier, not a complete semantic fact checker.
Known numeric membership does not certify every amount's business meaning. It
does not certify all inclusion/photo-count claims or replace owner confirmation,
tool consent guards, slot rechecks, pricing review or migrations. Data unavailable
for a claimed amount/duration causes withholding, not a static guessed price.
Date mentions without a supplied year use the existing business-calendar resolver.

No edition data is owner-confirmed. Bloom 1.5 hours/six photos remain seed values;
Empress conflicts remain pending. The lashes vector still needs approved removal.
Credential rotation, safe dev DB, migration baseline/application and read-only
runtime comparison remain user-side prerequisites. No real-customer tests,
database pushes, migrations or Pinecone operations were performed in this phase.