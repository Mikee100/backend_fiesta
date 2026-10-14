# Observability & Golden Evals

This document covers the two measurement foundations for the AI:

1. **Observability** — what is recorded per turn and how to query it.
2. **Golden evals** — the conversation regression suite that makes prompt, model
   and routing changes measurable.

Together they close Phase 1 of `docs/GAPS_AND_STRATEGIC_OPPORTUNITIES.md §1`
(Tier 1 metrics + strategy hit rates) and provide the harness that prompt/model
changes must pass before shipping.

---

## 1. Observability

### 1.1 Per-turn record: `AiJobMetric`

Every reply writes one `AiJobMetric` row in the background (never blocking the
reply), via `respond()` → `logAiJobMetric()` in
`src/services/agent/agent.service.ts` / `src/services/agent/usage-and-memory.ts`:

| Field | Meaning |
|---|---|
| `latencyMs` | Turn start → reply ready |
| `success` / `failureReason` | Whether the reply was a normal answer; short reason when not |
| `isFallback` | Generic recovery / handoff message was sent |
| `circuitBreakerTrip` / `circuitBreakerReason` | Breaker short-circuit |
| `platform` | whatsapp / instagram / web |
| **`strategyUsed`** | **Which layer produced the reply** (see below) |

### 1.2 `strategyUsed` — strategy hit rates

`strategyUsed` is written at every exit path of `handleMessage()`. Values:

| Value | Layer |
|---|---|
| `<route name>` (e.g. `greeting`, `openingHours`, `packageCatalog`, `legacyPackageName`, `scopeBoundary`, `runAgent`, …) | The named message route in `src/services/agent/routes.ts`. `runAgent` = fell through to the LLM. |
| `slotCapture` | Early booking-slot capture answered before routing |
| `slotCaptureError` | Slot capture failed; team-assistance reply |
| `circuitBreaker` | Breaker open → canned fallback |
| `cancellationDraft` | Stale-cancellation-draft pre-guard |
| `schemaMismatch` | Out-of-date DB schema maintenance reply |
| `automationDisabled` | `AI_AUTOMATION_ENABLED=false` |
| `noMatchingRoute` | Nothing matched → canned fallback |

Old rows written before this field was wired report `null` and aggregate as
`untracked`.

### 1.3 Querying: `GET /api/statistics/observability?days=7`

`AnalyticsController.getObservability` (registered in `app.ts`) returns one
payload covering the "single AI Observability page" from the gaps doc:

```jsonc
{
  "window": { "days": 7, "since": "..." },
  "jobs":    { "total", "failures", "fallbacks", "breakerTrips",
               "successRatePct", "fallbackRatePct" },
  "latency": { "avgMs", "p50Ms", "p95Ms", "maxMs", "sampleSize" },
  "strategyMix":  [ { "strategy", "count", "sharePct", "failures", "fallbacks" } ],
  "byPlatform":   [ { "platform", "jobs", "fallbacks", "fallbackPct", "avgLatencyMs" } ],
  "escalations":  { "total", "open", "byType": [ { "type", "count" } ] },
  "daily":        [ { "date", "jobs", "failures", "fallbacks" } ]
}
```

Adjacent endpoints (already existed): `/api/statistics/ai-performance`
(intent rollups, satisfaction), `/api/statistics/model-usage` (per-provider
tokens, failover, cooldown). Tests: `src/controllers/observability.controller.test.ts`.

> **Deployment note:** `strategyUsed` exists in `prisma/schema.prisma` and the
> generated client, but confirm the live `ai_job_metrics` table has the column
> (it was in the schema before the code started writing it). If it is missing,
> `logAiJobMetric` will swallow the insert error — watch for
> `Failed to log AI job metric` in server logs.

---

## 2. Golden evals

### 2.1 Two modes

| | Offline (`npm run evals`) | Live (`npm run evals:live`) |
|---|---|---|
| LLM | Stubbed, returns `EVAL_OFFLINE_LLM_MARKER_OK` | Real providers + failover |
| RAG / verifier / tools | Not exercised | Real |
| Database | Pinned unreachable (`connect_timeout=1`) | Real DB reads |
| Side effects | None (logging/escalation captured in memory) | Logging/escalation suppressed; no production rows |
| Cost / speed | Free, hermetic, CI-safe | Token costs, seconds per case |
| Measures | Routing + deterministic replies + guardrails | Everything offline measures + model output, RAG answers, verifier behaviour |

Offline mode models a *healthy database with no draft state*: the few methods
that read draft state (`rememberBookingSlots`, `getBookingProgressReply`,
`getGreetingReply`) are stubbed to their fresh-customer results so booking-ish
messages route exactly as they would for a new customer with a working DB.

### 2.2 Running

```powershell
npm run evals                     # offline, full set, exit code 1 on failure
npm run evals -- --filter policy  # subset by id/category
npm run evals -- --list           # inventory
npm run evals:live                # real model; needs GROQ_API_KEY
npm run evals -- --json my.json   # custom report path
```

Reports are written to `evals/results/<mode>-<timestamp>.json` (git-ignored).
The harness self-tests (`src/evals/harness.test.ts`) run inside `npm test`.

### 2.3 Case format (`evals/golden-conversations.json`)

```jsonc
{
  "id": "opening-hours",            // unique
  "category": "facts",              // used for --filter and summary grouping
  "message": "What are your opening hours?",
  "platform": "whatsapp",           // default whatsapp
  "history": [],                    // optional prior turns
  "setup": "tripCircuitBreaker",    // optional pre-turn hook (auto-reset)
  "modes": ["offline", "live"],     // optional restriction; default both
  "skip": false, "skipReason": "",  // skip requires a reason
  "expect": {
    "strategy": "openingHours",     // exact strategyUsed
    "strategies": ["a", "b"],       // any-of
    "notStrategies": ["runAgent"],
    "contains": ["Tuesday to Sunday"],        // case-insensitive substrings
    "notContains": ["..."],
    "matches": ["regex"], "forbidMatches": ["regex"],
    "reachesLlm": false,            // did the model layer run?
    "escalatedAs": "frustration",   // captured escalation type
    "equals": "exact reply"
  }
}
```

Validation runs on load (duplicate ids, unknown keys, empty expects are hard
errors), so a malformed set fails fast before any case runs.

### 2.4 Workflow: shipping a prompt/model/routing change

1. `npm run evals` — baseline must be green.
2. Make the change (prompt, route, model name, retrieval, catalog facts).
3. `npm run evals` again — routing regressions fail here first (free).
4. `npm run evals:live` — check real model answers; add/adjust `contains`
   assertions for facts you verified.
5. Deploy, then watch `GET /api/statistics/observability` for fallback rate,
   breaker trips and strategy-mix shifts in the following 24h.

New customer wording that exposed a bug → add a case to the golden set
(same rule as the regression-test convention in `backend/README.md`).

### 2.5 Known observations this suite already surfaced

- **Instagram booking intent reaches the LLM** — the WhatsApp-only redirect is
  enforced by prompt policy and tool guards, not a deterministic route. If that
  policy must be guaranteed, it should become a route; the
  `ig-booking-redirect` case will then fail loudly and tell you to update it.
- **`verifiedFacts` shadows `personalOutfit`** — outfit questions match the
  verified-facts route first in `createMessageRoutes` order, so the dedicated
  personal-outfit reply rarely fires (the facts reply is correct but less
  complete). The golden case accepts either route; tightening the order would
  be a deliberate routing change.
- Offline, every booking-keyword message hits draft-state reads
  (`rememberBookingSlots`) before routing — cheap in production, but it means
  the draft state machine is only covered by live/regression tests, not offline
  evals.

---

## 3. What this does *not* cover yet (next tiers)

- Booking funnel conversion and payment success rates (gaps doc Tier 3).
- Queue/debounce backlog gauges (no queue abstraction exists in backend 2.0).
- Retrieval-quality evals (recall@k over the Pinecone corpus) and golden cases
  that exercise the *live* output-verifier traps (amounts, retired editions) —
  live mode is the place to grow these.
- A frontend "AI Observability" page — the endpoint is queryable today; a
  dashboard can consume it when ready.

