-- AlterTable
ALTER TABLE "Stop" ADD COLUMN     "stayActivities" JSONB;

-- CreateTable
CREATE TABLE "OhvLinkCheck" (
    "id" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "okCount" INTEGER NOT NULL,
    "deadCount" INTEGER NOT NULL,
    "dead" JSONB NOT NULL,
    "driftWarning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OhvLinkCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OhvLinkCheck_createdAt_idx" ON "OhvLinkCheck"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_type_key" ON "Membership"("userId", "type");
