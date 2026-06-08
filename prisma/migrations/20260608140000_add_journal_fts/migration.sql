-- Full-text search for journal entries (step 5). Adds a Postgres GENERATED
-- ALWAYS ... STORED tsvector over title + body + placeName, plus a GIN index.
--
-- Prisma can't manage a generated tsvector column, so schema.prisma declares it
-- as `search Unsupported("tsvector")?` + `@@index([search], type: Gin)` for
-- drift-safety; the column's value and the index are created here in raw SQL.
--
-- Core PG15 features — no CREATE EXTENSION needed (plain to_tsvector('english')
-- + GIN). The column is GENERATED STORED, so Postgres backfills it for all
-- existing rows automatically when the column is added — no manual backfill.

-- AlterTable
ALTER TABLE "JournalEntry"
  ADD COLUMN "search" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' ||
      coalesce(body, '') || ' ' ||
      coalesce("placeName", ''))
  ) STORED;

-- CreateIndex
CREATE INDEX "JournalEntry_search_idx" ON "JournalEntry" USING GIN ("search");
