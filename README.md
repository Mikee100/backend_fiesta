# Fiesta AI Backend 2.0

This document describes the current AI system in backend 2.0 as implemented today: architecture, model/runtime behavior, response style, reliability controls, performance characteristics, and data structure.

Product positioning:
- Fiesta AI — Conversational Booking and Business Assistant

Scope of this README:
- AI request lifecycle for WhatsApp, Instagram, and web chat.
- RAG retrieval and tool-calling behavior.
- Booking and rescheduling safety flow.
- Runtime resilience, fallback, escalation, and observability.
- Current performance strategy (debounce, caching, indexing, socket-first updates).

## 1) System Overview

Fiesta AI in backend 2.0 is a production conversational booking and business assistant for Fiesta House that:
- Accepts inbound customer messages from WhatsApp and Instagram webhooks.
- Supports direct web chat via `POST /api/chat`.
- Uses RAG context from Pinecone + local embedding pipeline.
- Uses a Groq-hosted chat model through the OpenAI SDK compatibility layer.
- Executes controlled tools for booking, rescheduling, availability, and session notes.
- Uses deterministic safeguards for payment-triggering actions.
- Logs AI job metrics and sentiment signals for monitoring.

Core entrypoint:
- [backend 2.0/app.ts](app.ts)

Core AI orchestrator:
- [backend 2.0/src/services/agent/agent.service.ts](src/services/agent/agent.service.ts)

## 2) High-Level Architecture

```mermaid
flowchart TD
   WA[WhatsApp Webhook]\
   IG[Instagram Webhook]\
   WEB[Web Chat API]

   WA -->|verify signature| WAC[WhatsApp Controller]
   IG -->|verify signature| IGC[Instagram Controller]
   WEB --> CHATC[Chat Controller]

   WAC --> DB[(PostgreSQL via Prisma)]
   IGC --> DB
   CHATC --> AGENT[Agent Service]

   WAC --> DEBOUNCE[Debounce Service]
   IGC --> DEBOUNCE
   DEBOUNCE --> AGENT

   AGENT --> RAG[Knowledge Retrieval Service]
   RAG --> EMBED[Xenova all-MiniLM-L6-v2]
   RAG --> PINE[Pinecone Index]

   AGENT --> LLM[Groq Chat Model via OpenAI SDK]
   AGENT --> BOOK[Booking Service]
   AGENT --> CAL[Google Calendar Service]
   AGENT --> MPESA[M-Pesa Service]
   AGENT --> NOTIFY[Notification Service]

   NOTIFY --> SOCKET[Socket.io Admin Events]
   SOCKET --> DASH[Admin Frontend]

   AGENT --> METRIC[(AiJobMetric + SentimentScore + CustomerMemory)]
   BOOK --> DB
   CAL --> GCAL[Google Calendar]
   MPESA --> PAY[(Payment + Booking Draft)]
```

## 3) Runtime Style and Behavioral Contract

The assistant is intentionally style-constrained by system prompt rules in [backend 2.0/src/services/agent/agent.service.ts](src/services/agent/agent.service.ts):
- Friendly, empathetic, professional tone.
- Concise responses (target under 800 chars).
- Never fabricate booking data/time.
- Mandatory two-step booking and two-step reschedule flow.
- Platform-aware constraints:
   - On Instagram/Facebook: booking creation is disallowed; user is redirected to WhatsApp.
   - On WhatsApp/Web: booking tools are available.

This gives a hybrid behavior model:
- LLM handles language and conversational reasoning.
- Deterministic code paths enforce side-effect safety.

## 4) AI Model Stack and Configuration

### Chat model
- SDK: `openai` npm package.
- Provider endpoint: `https://api.groq.com/openai/v1`.
- API key: `GROQ_API_KEY`.
- Model selection order:
   1. `GROQ_CHAT_MODEL`
   2. `OPENAI_CHAT_MODEL`
   3. fallback default `llama-3.1-8b-instant`

Reference:
- [backend 2.0/src/services/agent/agent.service.ts](src/services/agent/agent.service.ts)

### Embeddings and retrieval
- Local embedder model: `Xenova/all-MiniLM-L6-v2`.
- Retrieval source: Pinecone vector index (`PINECONE_INDEX_NAME`, default `ai-business`).
- Default retrieval behavior: `topK=5` (agent calls with 10), `minScore=0.22` threshold.

References:
- [backend 2.0/src/services/knowledge/retrieval.service.ts](src/services/knowledge/retrieval.service.ts)
- [backend 2.0/src/services/knowledge/ingestion.service.ts](src/services/knowledge/ingestion.service.ts)
- [backend 2.0/src/services/knowledge/pinecone.service.ts](src/services/knowledge/pinecone.service.ts)

### Environment validation
Startup fails fast if critical env vars are missing/placeholder.

Reference:
- [backend 2.0/src/config/env-validation.ts](src/config/env-validation.ts)

## 5) End-to-End Request Lifecycle

### 5.1 WhatsApp inbound
1. `POST /webhooks/whatsapp` hits webhook route.
2. Signature verification runs (`verifyWhatsAppWebhook`).
3. Message deduplication by `externalId`.
4. Inbound message is persisted.
5. Non-text messages receive a fixed acknowledgement and skip AI.
6. Text messages are debounced per customer (6s pause window).
7. On flush, pending inbound burst is merged into one turn.
8. Agent runs with last conversation context and returns reply.
9. Outbound AI reply is persisted and sent via provider API.

References:
- [backend 2.0/src/routes/whatsapp.routes.ts](src/routes/whatsapp.routes.ts)
- [backend 2.0/src/middleware/verifyWebhook.ts](src/middleware/verifyWebhook.ts)
- [backend 2.0/src/controllers/whatsapp.controller.ts](src/controllers/whatsapp.controller.ts)
- [backend 2.0/src/services/messaging/debounce.service.ts](src/services/messaging/debounce.service.ts)

### 5.2 Instagram inbound
Flow is analogous to WhatsApp, but customer identity is mapped by `instagramId`.

References:
- [backend 2.0/src/routes/instagram.routes.ts](src/routes/instagram.routes.ts)
- [backend 2.0/src/controllers/instagram.controller.ts](src/controllers/instagram.controller.ts)

### 5.3 Web chat inbound
`POST /api/chat` directly calls `agentService.handleMessage(customerId, message, [], 'web')`.

Reference:
- [backend 2.0/src/controllers/chat.controller.ts](src/controllers/chat.controller.ts)

## 6) Agent Pipeline (What Actually Happens)

`handleMessage(...)` is the safe public API. It never throws to callers.

Order of operations:
1. Start timer for latency metric.
2. Run best-effort sentiment heuristic tracking.
3. Circuit-breaker gate check.
4. Daily token budget check (enforced in production only).
5. Deterministic explicit confirmation fast-path for short "yes/confirm" replies.
6. Execute full `runAgent(...)` pipeline.
7. Record token usage and AI job metric.
8. Update customer memory (best effort).
9. On errors: trip breaker logic, create escalation if appropriate, return safe fallback message.

Reference:
- [backend 2.0/src/services/agent/agent.service.ts](src/services/agent/agent.service.ts)

## 7) Tool-Calling Architecture

Tools are registered dynamically by platform:
- Always available: `add_session_note`.
- WhatsApp/Web only:
   - `propose_booking`
   - `confirm_booking`
   - `propose_reschedule`
   - `confirm_reschedule`
   - `get_available_slots`

The agent loops over tool calls up to `MAX_TOOL_ROUNDS = 5`.

### Critical booking safety invariants
These are enforced in code, not prompt-only:
- `confirm_booking` cannot execute if booking was proposed in the same turn.
- `confirm_booking` requires prior-turn draft state `awaiting_confirmation`.
- `confirm_reschedule` cannot execute if reschedule was proposed in the same turn.
- `confirm_reschedule` requires prior-turn draft state `reschedule_confirm`.

This prevents accidental payment prompt triggering from a single ambiguous message.

Reference:
- [backend 2.0/src/services/agent/agent.service.ts](src/services/agent/agent.service.ts)

## 8) Retrieval-Augmented Generation (RAG)

RAG flow:
1. Embed user query with local Xenova model.
2. Query Pinecone for nearest vectors.
3. Filter weak matches using score threshold.
4. Concatenate matched chunks into Business Context.
5. Inject context into system prompt for the chat model.

Ingestion flow:
- Scrape website + social sources.
- Chunk text.
- Embed each chunk.
- Upsert vectors to Pinecone.
- Save local JSON backup of embeddings.

References:
- [backend 2.0/src/services/knowledge/retrieval.service.ts](src/services/knowledge/retrieval.service.ts)
- [backend 2.0/src/services/knowledge/ingestion.service.ts](src/services/knowledge/ingestion.service.ts)

## 9) Reliability and Safety Controls

### 9.1 Circuit breaker
- Trips after 3 consecutive failures.
- Cooldown: 60 seconds.
- During open state, AI returns a static safe fallback.

### 9.2 Outage deduplication
- Provider-wide outage alerts are rate-limited (10-minute cooldown) to avoid alert floods.

### 9.3 Rate-limit/outage classification
- Provider 429 and `rate_limit_exceeded` are classified distinctly.

### 9.4 Token budget guard
- Per-customer daily token cap: 20,000.
- Enforced only in production.

### 9.5 Webhook authenticity
- Meta signatures verified from raw body.
- 360dialog shared-secret path supported.
- Optional local skip flag exists for troubleshooting only.

References:
- [backend 2.0/src/services/agent/resilience.service.ts](src/services/agent/resilience.service.ts)
- [backend 2.0/src/middleware/verifyWebhook.ts](src/middleware/verifyWebhook.ts)

## 10) AI Performance and Observability

### What is tracked
- Per-turn AI execution metrics in `AiJobMetric`:
   - `success`, `isFallback`, `failureReason`, `latencyMs`, breaker signals.
- Heuristic sentiment per inbound turn in `SentimentScore`.
- Customer profile/memory updates in `CustomerMemory`.

### Analytics endpoint
- AI performance summary endpoint computes:
   - avg latency
   - p95 latency
   - success rate
   - fallback rate
   - intent-level rollups (from `ConversationLearning`)

Reference:
- [backend 2.0/src/controllers/analytics.controller.ts](src/controllers/analytics.controller.ts)

### Important caveat
`ConversationLearning` is queried for some AI analytics but is not currently written by the main agent pipeline shown here. That means intent-level stats can be sparse unless other processes populate it.

## 11) Data Structures the AI Relies On

Most important models:
- `Customer`
- `Message`
- `Booking`
- `BookingDraft`
- `Payment`
- `CustomerMemory`
- `SentimentScore`
- `Escalation`
- `Notification`
- `AiJobMetric`

Reference:
- [backend 2.0/prisma/schema.prisma](prisma/schema.prisma)

### Why `BookingDraft` matters
`BookingDraft.step` is the workflow state anchor that prevents unsafe booking/reschedule confirmations in the same model turn.

## 12) Current Performance Design

### 12.1 Cost and latency controls
- Debounced burst handling (6 seconds): one AI call for multi-message bursts.
- Fallback responses avoid long retries when provider is down.
- Production token budget cap prevents runaway conversations.

### 12.2 Notification path optimization
- Unread-count endpoint has short in-memory cache (5s TTL).
- Cache invalidated on create/read state changes.
- Socket pushes send count updates in real time.

Reference:
- [backend 2.0/app.ts](app.ts)

### 12.3 Indexing for hot query paths
Schema currently includes indexes tuned for high-frequency filters/sorts in notifications, messages, bookings, escalations, invoices, and reminder/followup scheduling.

Reference:
- [backend 2.0/prisma/schema.prisma](prisma/schema.prisma)

## 13) Channel and Provider Details

### WhatsApp provider switching
The messaging layer supports:
- `meta` (direct Graph API)
- `360dialog` (BSP route)

Provider selected by `WHATSAPP_PROVIDER`.

Reference:
- [backend 2.0/src/services/messaging/whatsapp.service.ts](src/services/messaging/whatsapp.service.ts)

## 14) Error Handling Philosophy

Design principle: customer-facing flow should degrade gracefully.

- Agent path returns fallback string instead of crashing chat flow.
- Escalation creation is best effort and non-blocking to customer response.
- Non-critical writes (memory updates, notes fallback) are protected from taking down the turn.

## 15) Setup and Run

Prerequisites:
- Node.js 20+
- PostgreSQL
- Groq API key
- Pinecone (optional but required for vector retrieval quality)

Install:
```bash
npm install
```

Environment:
- Copy [.env.example](.env.example) to `.env` and set real values.

Database:
```bash
npx prisma generate
npx prisma db push
```

Development:
```bash
npm run dev
```

Tests currently wired:
```bash
npm test
```

## 16) Security Notes

- Startup env validation prevents placeholder credentials in required fields.
- Webhook signature verification validates authenticity.
- Keep `WHATSAPP_WEBHOOK_SKIP_SIGNATURE=false` outside local troubleshooting.

## 17) Known Limitations (Current State)

1. Sentiment is heuristic keyword-based, not model-based.
2. Embeddings are generated by a lightweight local model; quality can plateau on nuanced queries.
3. Notification count cache is in-process only (single-instance scope).
4. Some analytics dimensions depend on `ConversationLearning` data that may be under-populated.
5. Non-text customer media currently gets a polite ack but not semantic understanding.

## 18) Practical Improvement Backlog

Near-term improvements with high ROI:
1. Add structured intent/confidence telemetry from agent responses.
2. Add semantic understanding for common media attachment types.
3. Add regression test fixtures for booking/reschedule state transitions.
4. Add distributed cache (Redis) only when scaling to multi-instance backend.

---

Internal project: Fiesta House AI operations backend.
