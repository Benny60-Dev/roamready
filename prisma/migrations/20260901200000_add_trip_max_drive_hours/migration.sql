-- FEAT-TRIP-DRIVE-CAP: per-trip daily drive-time limit (hours). Nullable,
-- additive, no backfill. Null -> the user's TravelProfile.maxDriveHours (or the
-- 6h default) keeps governing, exactly as before.
ALTER TABLE "Trip" ADD COLUMN "maxDriveHours" DOUBLE PRECISION;
