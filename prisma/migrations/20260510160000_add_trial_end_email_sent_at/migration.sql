-- Idempotency marker for the trial-ending reminder email (sent 24h
-- before trialEndsAt by the cron endpoint at /api/v1/internal/cron/trial-ending).
-- Null on signup; populated when the reminder email is sent successfully.
ALTER TABLE "User" ADD COLUMN "trialEndEmailSentAt" TIMESTAMP(3);
