-- Broaden the founders'-welcome backfill. The first migration (20260703120000)
-- only marked PAID subscribers as already-welcomed, back when the note was meant
-- for subscribers. The note now greets EVERY new sign-up on first load, so mark
-- all remaining pre-existing accounts as already-welcomed too — only brand-new
-- accounts created from here on get the email.
UPDATE "User" SET "founderWelcomeSentAt" = CURRENT_TIMESTAMP WHERE "founderWelcomeSentAt" IS NULL;
