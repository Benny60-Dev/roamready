-- Convert pointsOfInterest from TEXT[] to JSONB {name, durationMinutes}.
-- Existing string values get durationMinutes: 30 (the default).

ALTER TABLE "Stop" ADD COLUMN "pointsOfInterest_new" JSONB NOT NULL DEFAULT '[]';

UPDATE "Stop"
SET "pointsOfInterest_new" = (
  CASE
    WHEN "pointsOfInterest" IS NULL OR array_length("pointsOfInterest", 1) IS NULL
    THEN '[]'::jsonb
    ELSE (
      SELECT jsonb_agg(jsonb_build_object('name', elem, 'durationMinutes', 30))
      FROM unnest("pointsOfInterest") AS elem
    )
  END
);

ALTER TABLE "Stop" DROP COLUMN "pointsOfInterest";
ALTER TABLE "Stop" RENAME COLUMN "pointsOfInterest_new" TO "pointsOfInterest";
