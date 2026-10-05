-- REVIEW ONLY. Apply only after backup/PITR and target/schema verification.
-- No slotContext, slotsUpdatedAt, inclusions, defaults, backfill or other changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "booking_drafts"
  ADD COLUMN IF NOT EXISTS "cancelProposedAt" TIMESTAMP(3);
COMMIT;