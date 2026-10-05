# BookingDraft P2022 recovery

The supplied error establishes a Prisma-client/database mismatch: the client selects
booking_drafts.cancelProposedAt but the connected database lacks it. Retrying the
same customer message cannot repair that. No database was inspected or changed here.

## Operator-only recovery order

1. Stop the connected dev server and live-number/webhook automation before DDL.
   Adding the column can make a watcher restart start accepting real traffic and
   cron jobs again; a schema fix is not permission for live-customer tests.
   Treat the remote database as production
   until an authorised owner verifies it contains no real customer/booking data.
2. Rotate the exposed connection credentials outside chat. Verify the target
   project, database and schema without printing connection strings or secrets.
3. Take/verify a backup or PITR restore capability before DDL. Record operator,
   target and rollback/restore plan; neither backup nor PITR was verified here.
4. Review docs/sql/cancel-proposed-at-review.sql and apply ONLY cancelProposedAt via
   the authorised SQL editor after checking the search path/target table. The
   column is nullable with no default. It avoids a data backfill/table rewrite,
   but still takes a DDL lock and can wait behind long transactions; the script
   uses a short lock timeout. IF NOT EXISTS does not validate an existing wrong type.
5. Read information_schema.columns to verify timestamp precision 3, nullable and
   no default. Leave slotContext, slotsUpdatedAt and packages.inclusions unapplied
   until the separate approved baseline/migration step. Do not use prisma db push
   or apply the older multi-column review script to repair this incident.
6. Restart through the authorised operator. Startup now connects and probes id
   and cancelProposedAt BEFORE listening, cron or embedder pre-warm. If readiness
   fails, it sets exit code 1, disconnects and does not accept webhooks.
7. Test Hello only with an approved internal/staging identity and controlled
   adapters. No live WhatsApp message, server restart or recovery SQL was executed
   by this coding task. Verify schema alert/maintenance metrics and normal response.

## Runtime behavior and logging

P2022 uses a distinct database_schema_out_of_date outcome, loud safe log banner
and operator-action escalation. The customer gets maintenance/contact-team copy,
not "please try again". A process-local ten-minute limiter prevents repeated
schema notifications; logs still show each failure. The existing escalation path
creates an OPEN row/dashboard alert, not proof of human acknowledgement. Its own
database write may fail if more tables are missing; the console banner remains.
Startup failures log safe code/model/column only, not raw Prisma errors/URLs.
The previous connection-URL diagnostic was removed, even though it attempted masking.

The probe checks the incident's required column even on an empty table; it is not
a complete audit of every table, type, index or migration. No schema bypass hides
the missing field, and cancellation logic remains unchanged.

## Model verification

Provider source uses GROQ_CHAT_MODEL, then OPENAI_CHAT_MODEL, then the source
default llama-3.1-8b-instant. The supplied runtime log says openai/gpt-oss-20b;
an environment override can explain it. No .env or credentials were read here,
so the actual deployed configuration is not independently verified.
The user explicitly confirmed openai/gpt-oss-20b as the intended deployment model
in this incident review. No model or environment setting was changed. Existing provider
tests pass openai/gpt-oss-20b to mocked clients, and tool-call guard tests use mock
completions. Those prove adapter/guard contracts, not real-model tool reliability.
Record the approved deployed model ID and run the gated real-model staging plan
after credentials/database/migration/retrieval prerequisites are resolved.