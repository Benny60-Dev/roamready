-- Snapshot of what a packing list was generated for ({ adults, children, pets,
-- petTypes, nights, generatedAt }). Additive + nullable; existing lists stay
-- null (treated as non-stale). Hand-authored — run via the normal migrate flow.

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "packingListMeta" JSONB;
