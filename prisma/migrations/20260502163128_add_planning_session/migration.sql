-- CreateEnum
CREATE TYPE "PlanningSessionStatus" AS ENUM ('PLANNING', 'COMPLETED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "PlanningSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "partialTripData" JSONB,
    "tripId" TEXT,
    "status" "PlanningSessionStatus" NOT NULL DEFAULT 'PLANNING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlanningSession_tripId_key" ON "PlanningSession"("tripId");

-- CreateIndex
CREATE INDEX "PlanningSession_userId_idx" ON "PlanningSession"("userId");

-- CreateIndex
CREATE INDEX "PlanningSession_userId_status_idx" ON "PlanningSession"("userId", "status");

-- AddForeignKey
ALTER TABLE "PlanningSession" ADD CONSTRAINT "PlanningSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningSession" ADD CONSTRAINT "PlanningSession_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
