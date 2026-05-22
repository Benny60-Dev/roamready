-- AlterTable
-- Block 8 — per-trip vehicle decisions captured at promote time by the
-- ConfirmVehiclesModal (after the AI emits an <itinerary>, before the
-- Trip row is created). Answers "what are you bringing on THIS trip?" —
-- distinct from the profile's "what do you own?" framing.
--   bringingTowed  : yes/no answer to "are you bringing the toad?" Only
--                    meaningful in the toad direction; tow-vehicle and
--                    no-second-vehicle cases leave it null. UI treats
--                    null/true as "yes" (the modal's default).
--   adHocVehicle   : optional one-off vehicle added from the modal's
--                    "+ Add a different vehicle for this trip" link.
--                    Trip-only — never written back to the profile.
-- Both nullable, non-destructive additive migration.
ALTER TABLE "Trip" ADD COLUMN "bringingTowed" BOOLEAN;
ALTER TABLE "Trip" ADD COLUMN "adHocVehicle" JSONB;
