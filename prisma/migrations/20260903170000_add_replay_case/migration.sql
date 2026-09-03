-- FEAT-REPLAY-CASES: saved replay regression cases. Additive: new enum + table only.
CREATE TYPE "ReplayCaseStatus" AS ENUM ('OPEN', 'PASSING', 'FIXED');

CREATE TABLE "ReplayCase" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ReplayCaseStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "sourceUserEmail" TEXT,
    "setup" JSONB NOT NULL,
    "turns" JSONB NOT NULL,
    "final" JSONB,
    "createdByEmail" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplayCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReplayCase_name_key" ON "ReplayCase"("name");
CREATE INDEX "ReplayCase_status_createdAt_idx" ON "ReplayCase"("status", "createdAt");
