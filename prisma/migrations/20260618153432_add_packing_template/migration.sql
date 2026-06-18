-- Saved/reusable packing lists (FR-SAVED-PACKING). Additive: new USER-level
-- PackingTemplate table + index + FK. No existing table is touched.
--
-- NOTE: prisma migrate dev also auto-generated an
--   ALTER TABLE "JournalEntry" ALTER COLUMN "search" DROP DEFAULT;
-- statement here — phantom drift against the GENERATED ALWAYS tsvector column
-- from 20260608140000_add_journal_fts (Postgres rejects DROP DEFAULT on
-- generated columns → error 42601). Removed by hand, same as prior migrations
-- (0610, 0615). The npm run preflight tripwire now blocks this statement so it
-- can't recur silently.

-- CreateTable
CREATE TABLE "PackingTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackingTemplate_userId_idx" ON "PackingTemplate"("userId");

-- AddForeignKey
ALTER TABLE "PackingTemplate" ADD CONSTRAINT "PackingTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
