-- Remove PRO_PLUS from the SubscriptionTier enum.
--
-- PostgreSQL does NOT support `ALTER TYPE ... DROP VALUE` directly. The
-- standard pattern is: downgrade rows, rename old enum, create new enum,
-- alter column to new enum, drop old enum.
--
-- Per the removal spec, all PRO_PLUS users in this DB are test accounts —
-- aggressive downgrade is fine. Their subscriptionId may still point at a
-- live Stripe sub for the old Pro+ price; cancel/refund those in the
-- Stripe Dashboard separately.

-- Step 1: downgrade any PRO_PLUS rows to PRO so the cast in step 4 succeeds.
UPDATE "User" SET "subscriptionTier" = 'PRO' WHERE "subscriptionTier" = 'PRO_PLUS';

-- Step 2: rename old enum out of the way.
ALTER TYPE "SubscriptionTier" RENAME TO "SubscriptionTier_old";

-- Step 3: create new enum without PRO_PLUS.
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO');

-- Step 4: re-type the column using the new enum (drop default first,
-- cast via text so Postgres lets us switch enum types, then restore the
-- default).
ALTER TABLE "User"
  ALTER COLUMN "subscriptionTier" DROP DEFAULT,
  ALTER COLUMN "subscriptionTier" TYPE "SubscriptionTier" USING ("subscriptionTier"::text::"SubscriptionTier"),
  ALTER COLUMN "subscriptionTier" SET DEFAULT 'FREE';

-- Step 5: drop the old enum (no remaining references).
DROP TYPE "SubscriptionTier_old";
