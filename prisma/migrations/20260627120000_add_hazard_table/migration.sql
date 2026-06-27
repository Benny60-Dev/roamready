-- CreateEnum
CREATE TYPE "HazardType" AS ENUM ('GRADE', 'LENGTH_BAN', 'HEIGHT_BAN', 'WIDTH_BAN', 'WEIGHT_BAN', 'PROPANE_TUNNEL', 'VEHICLE_BAN');

-- CreateEnum
CREATE TYPE "HazardConfidence" AS ENUM ('HIGH', 'MED', 'LOW');

-- CreateTable
CREATE TABLE "Hazard" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "hazardType" "HazardType" NOT NULL,
    "maxLengthFt" DOUBLE PRECISION,
    "maxHeightFt" DOUBLE PRECISION,
    "maxWidthFt" DOUBLE PRECISION,
    "maxWeightLbs" INTEGER,
    "gradePct" DOUBLE PRECISION,
    "propaneBanned" BOOLEAN NOT NULL DEFAULT false,
    "confidence" "HazardConfidence" NOT NULL,
    "source" TEXT NOT NULL,
    "roadDesignation" TEXT,
    "detourWaypoint" TEXT,
    "segmentPolyline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hazard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Hazard_state_idx" ON "Hazard"("state");
