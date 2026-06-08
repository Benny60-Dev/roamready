-- Manual visited-state marks for the Journal map (step 6b, scope Option B).
-- New, empty table — no backfill. Mirrors the standard Prisma CREATE TABLE +
-- index + FK shape (see 20260505220343_add_travel_party_models).

-- CreateTable
CREATE TABLE "VisitedState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "visitType" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitedState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VisitedState_userId_idx" ON "VisitedState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitedState_userId_state_key" ON "VisitedState"("userId", "state");

-- AddForeignKey
ALTER TABLE "VisitedState" ADD CONSTRAINT "VisitedState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
