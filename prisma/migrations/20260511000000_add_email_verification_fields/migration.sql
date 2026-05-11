-- Add email-verification state to User. Phase 1 of email verification
-- rollout — schema + magic-link flow only; signup hooks, UI, and the
-- grace-period middleware come in later phases.
--
-- IMPORTANT: existing users are NOT backfilled to emailVerified=true.
-- All existing accounts (including the owner) start at false so the
-- full verification flow can be exercised against real production data.
-- The DEFAULT false on the column means new signups and existing rows
-- both land in the same starting state.

ALTER TABLE "User"
  ADD COLUMN "emailVerified"           BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN "emailVerificationToken"  TEXT,
  ADD COLUMN "emailVerificationSentAt" TIMESTAMP(3);

-- Unique constraint on the token. Nullable column → Postgres allows
-- multiple NULLs but enforces uniqueness among non-NULL values, which
-- is exactly what we want (most users have no active token in flight).
CREATE UNIQUE INDEX "User_emailVerificationToken_key" ON "User"("emailVerificationToken");
