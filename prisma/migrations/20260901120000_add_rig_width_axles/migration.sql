-- FEAT-RIG-DIMENSIONS: additive nullable width/axle columns (no backfill).
-- widthInches: RV body width in INCHES (US convention; 96-102 typical;
--   null -> LVR keeps the documented safe default 102 in).
-- axleCount: total axles on the road incl. tag/trailer axles (null -> 2).
ALTER TABLE "Rig" ADD COLUMN "widthInches" DOUBLE PRECISION;
ALTER TABLE "Rig" ADD COLUMN "axleCount" INTEGER;
