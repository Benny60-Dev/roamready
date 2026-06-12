-- Admin feedback archive: nullable timestamp (null = active). Set/cleared by
-- the admin PATCH; intentionally NOT consulted by the public roadmap query.

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN "archivedAt" TIMESTAMP(3);
