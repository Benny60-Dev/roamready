-- Founder-rate forfeiture timestamp (FOUNDER-FORFEIT-1). Set by the
-- customer.subscription.deleted webhook when a founder voluntarily cancels
-- (cancellation_details.reason = 'cancellation_requested'); founderPricing
-- is demoted to false in the same write.
--
-- NOTE: prisma migrate dev also auto-generated an
--   ALTER TABLE "JournalEntry" ALTER COLUMN "search" DROP DEFAULT;
-- statement here — phantom drift against the GENERATED ALWAYS tsvector
-- column from 20260608140000_add_journal_fts (Postgres rejects DROP DEFAULT
-- on generated columns). Removed by hand, same as prior migrations.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "founderRateForfeitedAt" TIMESTAMP(3);
