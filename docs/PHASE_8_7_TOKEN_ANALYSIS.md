# Phase 8.7 token analysis and cutoff handoff

## Decision

Keep DAILY_TOKEN_CAP unchanged. The source default remains 50,000 per customer per
day; an existing environment override may differ and was not read. No cap,
exemption, reset, retry limit, prompt content or usage-accounting change is made.
Only cutoff wording and its handoff escalation change in this phase.

No real AGENT_USAGE conversation logs were found in workspace log/JSONL files,
including ignored files. No file logger was found near the usage path: the code
writes console output. Prior terminal/test/replay usage counters are mocked and
are not real provider measurements. No production logs or credentials were opened.
Real token totals, component allocation and live regeneration rate are unavailable.
There is no defensible numeric cap change to propose from these inputs.

## Offline footprint: five largest initial contributors

These are characters, NOT tokens. Trusted source prompt methods and tool literals
were parsed with TypeScript and rendered in an isolated VM, without application
imports, providers, database calls or model tokenizers. Time was fixed to Sunday,
October 4, 2026, 12:00 PM. The sample assumes WhatsApp with pricing/tools exposed.
Local FAQ rows packages1, pkg_bloom and pkg_empress supply a representative three-
chunk fixture. Those rows are not owner-verified. History/context are explicit
small fixtures, not captured real conversations.

| Rank | Initial contributor | Characters | Evidence |
| --- | --- | ---: | --- |
| 1 | Base system prompt, pricing included, customer context empty | 15,919 | Existing getSystemPrompt render |
| 2 | Exposed tool definitions, JSON serialized | 6,718 | Existing availableTools literals |
| 3 | Three fixture RAG chunks plus separators | 2,204 | Chunk lengths 1,583 / 231 / 380 |
| 4 | Six fixture history messages plus separators | 392 | Explicit local fixture |
| 5 | Customer context fixture, excluding RAG | 325 | Includes 117-character Known so far line |

The current message adds 17 characters. Summed visible content is 25,575
characters, excluding message/schema framing and actual full-context metadata.
The base prompt without pricing sections is still 15,550 characters, only 369
less. The add-on pricing line is 399 characters within the pricing-enabled base.
The 325-character context fixture omits the computed-calendar line and can grow
with bookings, notes, recipients and long-term memory; it is not a full runtime
context size or a maximum. Do not divide these characters by an assumed constant
and report the result as measured tokens. The ranking is a fixture proxy only.

## Tool rounds and verifier retries

### Tool exposure by turn type

An isolated evaluation of the actual shouldExposeTools methods produced this
matrix (empty history, WhatsApp). Gate=true exposes all nine schemas, not an
intent-specific subset. No gating behavior is changed in this phase.

| Turn type/example | Raw gate | Effective path |
| --- | --- | --- |
| Hello | Off | Natural reply, no schemas |
| Where is the studio? | Off | Natural reply in natural mode, no schemas |
| What happens after the session? | Off | Deterministic policy reply |
| How much is THE BLOOM? | Off | Price-only model path, no schemas |
| What extras do you have? | Off | Deterministic list |
| How do I book? | On | Deterministic process reply, no model call |
| Which dates are available next week? | On | All nine schemas, date-range tool forced |
| 6th October, 10am | On | All nine schemas if model path reached |
| Please add an extra outfit | On | Deterministic capture, no model call |
| Send the download link by email | On | All nine schemas if model path reached |
| confirm | On | Deterministic pending confirmation when applicable, otherwise gated model path |
| Is the makeup inclusive of lashes? | Off | Natural reply/verifier, no schemas |

Instagram returned false for every sample. The nine tool names are add_session_note,
propose_booking, confirm_booking, propose_reschedule, confirm_reschedule,
get_available_slots, get_available_dates, cancel_booking, save_delivery_preference.
Plain information questions in this sample keep schemas off. Date/time signals
and broad action keywords turn the complete set on; real conversation distribution
is unknown. Report actual tool counts per staging turn before asserting "most".
Per-intent tool subsets are a future separately validated optimization, not part
of 8.7. In this fixture, fixed base+schemas are 22,637 of 25,558 listed characters
(88.6%) when tools are exposed; this is not a measured token share.

### Provider prompt caching check

Read-only official documentation review on 2026-10-04; no provider API call or
cache creation was made. Source defaults are Groq llama-3.1-8b-instant and Gemini
gemini-2.5-flash, with environment overrides possible and not inspected.

Gemini's caching documentation describes implicit caching for 2.5+ models, with
a listed 2,048-input-token threshold for 2.5 Flash, common-prefix recommendations,
and cached-token usage reporting. Its OpenAI compatibility documentation also
documents cached_content via extra_body for explicit cached resources. The current
route uses the OpenAI-compatible endpoint and passes no explicit cached-content
resource. The compatibility layer is beta; actual cache-hit counters and savings
must be verified on the configured staging model/endpoint. No cache hit is claimed.

Groq's official prompt-caching page could not be retrieved by the webpage tool
(ERR_BLOCKED_BY_CSP). Model-specific support, discounts and quota treatment remain
unverified here; do not assume support for the configured model. Both provider
records currently save aggregate input/output/total tokens, not cached-token metrics.

The current system prompt begins with a changing timestamp and places per-customer
Business Context before the long shared policy. That weakens an identical fixed
prefix across customers/time. Moving stable instructions first could help caching,
but is a separately validated prompt-layout change, not done here. Cache discounts
do not automatically imply relief from per-customer or provider quota accounting.

Documentation reviewed:
- https://ai.google.dev/gemini-api/docs/caching
- https://ai.google.dev/gemini-api/docs/openai
- https://console.groq.com/docs/prompt-caching (retrieval blocked)

Each completion sends accumulated messages again. Tool rounds repeat the system
prompt, context, RAG and history, plus assistant calls and tool results. The normal
tool loop allows up to three rounds after the initial completion. Those rounds
can dominate total per-turn input even though initial RAG/history are short.

The twelve-turn mocked replay observed one verifier correction, a 1,019-character
added corrective system message and eight total mock completions. No model tokens
can be inferred from the fixture's synthetic usage values. A correction has no
tools, but repeats existing message context and the offending draft. Its actual
cost is the complete correction request plus generated output, not 1,019 chars.

Sensitivity only: if eligible model turns need correction at 5% or 10%, and one
correction costs the same as one ordinary completion, overhead is roughly 5% or
10% of that one-completion baseline. Actual overhead depends on accumulated tool
messages, correction output and the baseline number of completions. This is not
a measured retry rate or an endorsement of any cap. Tool rounds and retries are
overlapping repeated-request overhead, not extra initial sections to double-count.

## Staging measurement proposal: numbers to collect, not new limits

After credentials, safe dev DB/migrations, owner answers and stale lashes-vector
removal, capture one staging week and at least 100 reviewed turns where feasible.
Include low-risk conversation, booking proposals, add-ons, follow-ups, reschedules,
tool-heavy turns and deliberate verifier faults. Do not use the production number
or contact real customers before those prerequisites are met.

For each provider completion, capture a turn/call id, input/output token totals,
call role (initial/tool round/verifier correction), tool schema size, and separate
system-base/customer-context/RAG/history/user/tool-message sizes. Preserve verifier
reason, checked/retry flags, correctionChars, completionCalls and latency already
present in AGENT_USAGE. Source component tokens require the exact model-compatible
tokenizer or provider-supported counting; reconcile its estimate to prompt_tokens,
including tools/framing. Current aggregate AGENT_USAGE cannot supply that split.
This instrumentation/tokenizer work is proposed, not implemented in 8.7.

Report the six requested components (base system, context, RAG, history, tool
rounds, verifier retries), mean/median/p95 tokens, completions per turn, retry rate
among eligible model turns AND all customer turns, and actual input/output shares.
Rank the five largest measured contributors using mutually exclusive accounting:
allocate repeated request sections to their completion category rather than count
them twice. Label raw conversation samples correct/wrong and verifier blocks
true/false positive. Successful regeneration alone is not a false-positive label.

Only then propose a cap from observed valid multi-turn journeys, per-customer
daily usage, provider account-wide TPM/TPD limits and retry/tool overhead. Any cap
change needs separate approval. The per-customer cap cannot solve shared provider
exhaustion. Existing non-production budget bypass and server-local date resets
remain unchanged and must be considered when designing staging measurements.

## Cutoff reply and human ownership

Customer text:
"Thank you for your patience. A member of our team will pick this up with you shortly."

The budget guard takes no model/tool action. It requests a quota escalation with
customer message, platform, configured cap, requiresHumanReply=true, a business-
day response target and assignedOwner=null. Existing escalation code stores an
OPEN row and creates a dashboard notification; it does not prove receipt or human
acknowledgement. The generic provider-outage/circuit fallback is unchanged.

The user confirmed the handoff owner is STILL UNASSIGNED on 2026-10-04. A named
studio staff member and backup must claim verifier/quota handoffs, watch suppressed
repeat outcomes, acknowledge the original alert and reply within the business
day. Establish off-hours/closed-Monday handling before launch. "Shortly" is now a
customer promise: do NOT deploy this wording until an owner and alert workflow can
honour it. An unread fallback remains a customer left waiting.

Proposed staffing rule for studio approval: the named duty studio concierge owns
the verifier/quota queue during each staffed shift, with a named studio-manager
backup. Acknowledge within 15 minutes during staffed hours and send a human reply
within the business day; agree what "shortly" means and the off-hours wording.
An approved WhatsApp/email alert to that duty reader should supplement the
dashboard. No person, address, phone number or alert delivery is confirmed here;
no external-send mechanism was added. The deployment checklist must record the
reader/backup, hours, alert destination, delivery test and acknowledgement test.
If staffing/alerts are absent, keep rollout blocked rather than imply coverage.

Verifier escalation throttling and the circuit breaker are process-local and
reset on restart; multiple instances can duplicate alerts. Record this scaling
limit. Do not build distributed throttling or change these controls in 8.7.

## Remaining launch blockers

Delete/re-ingest the stale lashes vector only through approved Pinecone access
after key rotation. Ask the owner about Empress inclusions, Bloom duration/photos,
the exact-72-hour boundary, whether the Ksh 2,000 deposit is flat and the refund
follow-up owner. No package data is owner-confirmed. Rotate exposed credentials,
create a safe dev DB, baseline migrations and apply cancelProposedAt, the 8.1b
columns and packages.inclusions together. Perform a read-only non-production
live-versus-seed comparison. No external operations were performed here.