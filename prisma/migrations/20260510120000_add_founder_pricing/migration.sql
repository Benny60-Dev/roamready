-- Add founderPricing flag to User. Set at signup based on whether the
-- user joined before FOUNDER_CUTOFF_DATE (see server/src/config/founderPricing.ts).
-- Default false; existing rows stay false (no backfill — per the design
-- decision, only NEW signups before the cutoff get the founder rate).

ALTER TABLE "User" ADD COLUMN "founderPricing" BOOLEAN NOT NULL DEFAULT false;
