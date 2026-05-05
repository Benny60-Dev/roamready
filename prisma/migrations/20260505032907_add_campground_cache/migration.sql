-- AlterEnum
ALTER TYPE "AICallType" ADD VALUE 'PLACES_LOOKUP';

-- AlterTable
ALTER TABLE "Stop" ADD COLUMN     "campgroundCandidates" JSONB;

-- CreateTable
CREATE TABLE "CampgroundCache" (
    "id" TEXT NOT NULL,
    "queryName" TEXT NOT NULL,
    "queryLocation" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "found" BOOLEAN NOT NULL,
    "placeId" TEXT,
    "name" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "googleMapsUrl" TEXT,
    "rating" DOUBLE PRECISION,
    "userRatingCount" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampgroundCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampgroundCache_cacheKey_key" ON "CampgroundCache"("cacheKey");

-- CreateIndex
CREATE INDEX "CampgroundCache_cacheKey_idx" ON "CampgroundCache"("cacheKey");

-- CreateIndex
CREATE INDEX "CampgroundCache_expiresAt_idx" ON "CampgroundCache"("expiresAt");
