-- AlterTable: one-time founders' welcome send-once guard.
ALTER TABLE "User" ADD COLUMN "founderWelcomeSentAt" TIMESTAMP(3);

-- Backfill: mark all EXISTING paid subscribers as already-welcomed so this
-- feature only ever emails NEW subscribers going forward (never blasts current
-- customers on their next login).
UPDATE "User" SET "founderWelcomeSentAt" = CURRENT_TIMESTAMP WHERE "subscriptionId" IS NOT NULL;
