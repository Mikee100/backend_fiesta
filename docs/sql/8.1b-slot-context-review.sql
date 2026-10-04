-- REVIEW ONLY. Do not apply before backup, baseline, and target verification.
-- This is additive SQL, not a migration baseline for the existing database.
BEGIN;
ALTER TABLE "booking_drafts"
  ADD COLUMN IF NOT EXISTS "cancelProposedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "slotContext" JSONB,
  ADD COLUMN IF NOT EXISTS "slotsUpdatedAt" TIMESTAMP(3);
COMMIT;