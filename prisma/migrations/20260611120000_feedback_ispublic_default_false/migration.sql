-- Feedback privacy flip: submissions are private by default; only the admin
-- Public toggle (PATCH /admin/feedback/:id) makes a row roadmap-eligible.

-- AlterTable
ALTER TABLE "Feedback" ALTER COLUMN "isPublic" SET DEFAULT false;

-- Existing rows predate the policy — none were knowingly published by an
-- admin, so flip them all private. Admins re-publish via the toggle.
UPDATE "Feedback" SET "isPublic" = false;
