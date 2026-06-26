-- Marketing email opt-in (FR-MARKETING-OPTIN). The CAN-SPAM consent basis for
-- FR-WINBACK and any promotional sends. Captured by an explicit, separate opt-in
-- modal at onboarding (NOT bundled with ToS acceptance).
--
-- marketingConsent  — the answer. Default false; existing rows stay false (no
--                     backfill — silence is never consent under CAN-SPAM).
-- marketingConsentAt — stamped when the user makes ANY decision (opt-in OR
--                     "No thanks"). A NULL timestamp therefore means "not yet
--                     asked", which is what gates whether the opt-in modal shows.
--
-- Hand-authored LF-only (per the project's migrate-diff → hand-write path); the
-- phantom JournalEntry "ALTER COLUMN search DROP DEFAULT" line is absent by
-- construction (no migrate dev was run).

-- AlterTable
ALTER TABLE "User" ADD COLUMN "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "marketingConsentAt" TIMESTAMP(3);
