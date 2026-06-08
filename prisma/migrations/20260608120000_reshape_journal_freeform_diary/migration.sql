-- Reshape JournalEntry from a required 1:1-with-Stop record into a per-user
-- freeform diary entry. stopId becomes optional (and non-unique), a required
-- userId owner is added, and an optional tripId plus denormalized location
-- fields are introduced.
--
-- Production-safety note: userId is REQUIRED but the table may hold existing
-- rows. We add it nullable, backfill it from the existing Stop -> Trip -> userId
-- chain (which is fully resolvable because stopId was previously REQUIRED with a
-- CASCADE FK, so every existing row has a valid stop/trip/owner), then promote
-- it to NOT NULL.

-- DropForeignKey (stopId FK is recreated below as SET NULL since stopId is now optional)
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_stopId_fkey";

-- DropIndex (stopId is no longer unique: a stop can now have multiple entries)
DROP INDEX "JournalEntry_stopId_key";

-- AlterTable: relax stopId to nullable and add the new diary columns.
-- userId is added nullable here and promoted to NOT NULL after backfill.
ALTER TABLE "JournalEntry" ALTER COLUMN "stopId" DROP NOT NULL,
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "tripId" TEXT,
ADD COLUMN     "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION,
ADD COLUMN     "placeName" TEXT,
ADD COLUMN     "tags" TEXT[];

-- Backfill: derive the owning userId for existing rows via Stop -> Trip.
UPDATE "JournalEntry"
SET "userId" = (
    SELECT t."userId"
    FROM "Stop" s
    JOIN "Trip" t ON s."tripId" = t."id"
    WHERE s."id" = "JournalEntry"."stopId"
)
WHERE "stopId" IS NOT NULL;

-- Backfill: denormalize tripId for existing rows from their stop's trip.
UPDATE "JournalEntry"
SET "tripId" = (
    SELECT s."tripId"
    FROM "Stop" s
    WHERE s."id" = "JournalEntry"."stopId"
)
WHERE "stopId" IS NOT NULL;

-- Backfill: existing entries predate entryDate; seed it from their createdAt
-- so they sort correctly in the diary instead of all collapsing to migration time.
UPDATE "JournalEntry" SET "entryDate" = "createdAt";

-- Now that every existing row has an owner, enforce NOT NULL on userId.
ALTER TABLE "JournalEntry" ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "JournalEntry_userId_entryDate_idx" ON "JournalEntry"("userId", "entryDate");

-- CreateIndex
CREATE INDEX "JournalEntry_userId_state_idx" ON "JournalEntry"("userId", "state");

-- CreateIndex
CREATE INDEX "JournalEntry_tripId_idx" ON "JournalEntry"("tripId");

-- CreateIndex
CREATE INDEX "JournalEntry_stopId_idx" ON "JournalEntry"("stopId");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
