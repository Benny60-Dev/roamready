-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('FREE', 'PRO', 'PRO_PLUS');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('RV_CLASS_A', 'RV_CLASS_B', 'RV_CLASS_C', 'FIFTH_WHEEL', 'TRAVEL_TRAILER', 'TOY_HAULER', 'POP_UP', 'VAN', 'CAR_CAMPING');

-- CreateEnum
CREATE TYPE "TripStatus" AS ENUM ('PLANNING', 'ACTIVE', 'COMPLETED', 'DRAFT');

-- CreateEnum
CREATE TYPE "StopType" AS ENUM ('DESTINATION', 'OVERNIGHT_ONLY', 'HOME');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('NOT_BOOKED', 'PENDING', 'CONFIRMED', 'CANCELLED', 'WAITLISTED');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('OK', 'DUE_SOON', 'OVERDUE');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('FEATURE_REQUEST', 'BUG_REPORT', 'GENERAL', 'CAMPGROUND_REVIEW');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('NEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "googleId" TEXT,
    "appleId" TEXT,
    "phone" TEXT,
    "emergencyContact" TEXT,
    "emergencyPhone" TEXT,
    "homeLocation" TEXT,
    "avatarUrl" TEXT,
    "subscriptionTier" "SubscriptionTier" NOT NULL DEFAULT 'FREE',
    "subscriptionId" TEXT,
    "customerId" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "subscriptionEndsAt" TIMESTAMP(3),
    "isOwner" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "year" INTEGER,
    "make" TEXT,
    "model" TEXT,
    "length" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "fuelType" TEXT,
    "mpg" DOUBLE PRECISION,
    "tankSize" DOUBLE PRECISION,
    "slideouts" TEXT,
    "electricalAmps" TEXT,
    "towingSetup" TEXT,
    "isToyHauler" BOOLEAN NOT NULL DEFAULT false,
    "garageLength" DOUBLE PRECISION,
    "gvwr" DOUBLE PRECISION,
    "towVehicle" TEXT,
    "toys" JSONB,
    "terrainTypes" JSONB,
    "isVan" BOOLEAN NOT NULL DEFAULT false,
    "vanLength" TEXT,
    "powerSetup" JSONB,
    "waterCapacity" DOUBLE PRECISION,
    "hasStarlink" BOOLEAN NOT NULL DEFAULT false,
    "isRemoteWorker" BOOLEAN NOT NULL DEFAULT false,
    "isCamper" BOOLEAN NOT NULL DEFAULT false,
    "sleepSetup" TEXT,
    "isOffRoad" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "currentMiles" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "travelStyle" TEXT,
    "maxDriveHours" DOUBLE PRECISION,
    "maxMilesPerDay" INTEGER,
    "nightlyBudget" DOUBLE PRECISION,
    "hookupPreference" TEXT,
    "campgroundTypes" JSONB,
    "interests" JSONB,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "hasPets" BOOLEAN NOT NULL DEFAULT false,
    "petDetails" JSONB,
    "accessibilityNeeds" JSONB,
    "militaryStatus" TEXT,
    "firstResponder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravelProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "memberNumber" TEXT,
    "planTier" TEXT,
    "expiresAt" TIMESTAMP(3),
    "autoApply" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rigId" TEXT,
    "name" TEXT NOT NULL,
    "status" "TripStatus" NOT NULL DEFAULT 'PLANNING',
    "startLocation" TEXT NOT NULL,
    "endLocation" TEXT NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "totalMiles" DOUBLE PRECISION,
    "totalNights" INTEGER,
    "estimatedFuel" DOUBLE PRECISION,
    "estimatedCamp" DOUBLE PRECISION,
    "actualFuel" DOUBLE PRECISION,
    "actualCamp" DOUBLE PRECISION,
    "fuelPrice" DOUBLE PRECISION,
    "sharedToken" TEXT,
    "packingList" JSONB,
    "aiConversation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stop" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "type" "StopType" NOT NULL DEFAULT 'DESTINATION',
    "locationName" TEXT NOT NULL,
    "locationState" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "arrivalDate" TIMESTAMP(3),
    "departureDate" TIMESTAMP(3),
    "nights" INTEGER NOT NULL DEFAULT 1,
    "campgroundName" TEXT,
    "campgroundId" TEXT,
    "bookingStatus" "BookingStatus" NOT NULL DEFAULT 'NOT_BOOKED',
    "confirmationNum" TEXT,
    "siteRate" DOUBLE PRECISION,
    "estimatedFuel" DOUBLE PRECISION,
    "hookupType" TEXT,
    "isPetFriendly" BOOLEAN,
    "isMilitaryOnly" BOOLEAN NOT NULL DEFAULT false,
    "isCompatible" BOOLEAN NOT NULL DEFAULT true,
    "incompatibilityReasons" JSONB,
    "alternates" JSONB,
    "weatherForecast" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "rating" INTEGER,
    "photos" JSONB,
    "actualCost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceItem" (
    "id" TEXT NOT NULL,
    "rigId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intervalMiles" INTEGER,
    "intervalMonths" INTEGER,
    "lastServiceMiles" INTEGER,
    "lastServiceDate" TIMESTAMP(3),
    "currentMiles" INTEGER,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'OK',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLog" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "mileage" INTEGER,
    "notes" TEXT,
    "cost" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RigDatabase" (
    "id" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "class" TEXT NOT NULL,
    "length" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "fuel" TEXT,
    "mpg" DOUBLE PRECISION,
    "tank" DOUBLE PRECISION,
    "slides" TEXT,
    "amps" TEXT,

    CONSTRAINT "RigDatabase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "FeedbackType" NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "screen" TEXT,
    "rating" INTEGER,
    "importance" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'NEW',
    "votes" INTEGER NOT NULL DEFAULT 0,
    "voterIds" JSONB,
    "rigType" TEXT,
    "tripContext" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "method" JSONB NOT NULL,

    CONSTRAINT "NotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "TravelProfile_userId_key" ON "TravelProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_sharedToken_key" ON "Trip"("sharedToken");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_stopId_key" ON "JournalEntry"("stopId");

-- AddForeignKey
ALTER TABLE "Rig" ADD CONSTRAINT "Rig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelProfile" ADD CONSTRAINT "TravelProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stop" ADD CONSTRAINT "Stop_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "Stop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceItem" ADD CONSTRAINT "MaintenanceItem_rigId_fkey" FOREIGN KEY ("rigId") REFERENCES "Rig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceLog" ADD CONSTRAINT "MaintenanceLog_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaintenanceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSetting" ADD CONSTRAINT "NotificationSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
