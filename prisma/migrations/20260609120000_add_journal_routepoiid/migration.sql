-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "routePoiId" TEXT;

-- CreateIndex
CREATE INDEX "JournalEntry_routePoiId_idx" ON "JournalEntry"("routePoiId");
