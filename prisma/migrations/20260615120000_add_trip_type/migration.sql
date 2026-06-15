-- Persisted trip shape (BUG-4 Phase 1). Additive + nullable: existing Trip rows
-- get NULL ("legacy/unknown") and consumers fall back to stop-shape inference.
-- No default, no backfill, no data rewrite. Hand-authored to exclude the known
-- phantom JournalEntry.search DROP DEFAULT (tsvector default Prisma's diff keeps
-- re-proposing) — that recurrence is intentionally NOT part of this migration.

-- CreateEnum
CREATE TYPE "TripType" AS ENUM ('ROUND_TRIP', 'ONE_WAY');

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "tripType" "TripType";
