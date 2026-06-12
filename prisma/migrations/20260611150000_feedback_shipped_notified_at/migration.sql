-- Shipped-notification stamp: when the submitter was emailed that their
-- feedback item shipped (null = never notified). Stamped only after a
-- successful send; doubles as the idempotency guard against re-sends.

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN "shippedNotifiedAt" TIMESTAMP(3);
