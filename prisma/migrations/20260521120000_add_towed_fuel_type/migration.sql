-- AlterTable
-- Block 7 — adds two columns to capture extra second-vehicle data:
--   towedHeight   : feet, optional. Only collected in the TOW VEHICLE direction
--                   (truck pulling a trailer/5th wheel) for future bridge-
--                   clearance and garage-fit checks. Toad sub-form omits it
--                   since a flat-towed Jeep's height doesn't matter for the
--                   rig's own restrictions.
--   towedFuelType : Gas/Diesel/Electric, optional. Also TOW VEHICLE only —
--                   diesel range/cost matters for the prime mover. Toad fuel
--                   doesn't matter (unhooked at camp).
-- Direction is computed at read time from Rig.vehicleType (never stored) —
-- see client/src/utils/rigs.ts deriveSecondVehicle. Non-destructive additive
-- migration.
ALTER TABLE "Rig" ADD COLUMN "towedHeight" DOUBLE PRECISION;
ALTER TABLE "Rig" ADD COLUMN "towedFuelType" TEXT;
