-- CreateEnum
CREATE TYPE "PersonRole" AS ENUM ('ADULT', 'TEEN', 'CHILD', 'INFANT');

-- CreateEnum
CREATE TYPE "PetType" AS ENUM ('DOG', 'CAT', 'OTHER');

-- CreateTable
CREATE TABLE "TravelParty" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "tripId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravelParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "role" "PersonRole" NOT NULL DEFAULT 'ADULT',
    "name" TEXT,
    "age" INTEGER,
    "isTraveling" BOOLEAN NOT NULL DEFAULT true,
    "isEmergencyContact" BOOLEAN NOT NULL DEFAULT false,
    "emergencyPhone" TEXT,
    "accessibilityNeeds" JSONB,
    "dietaryNotes" TEXT,
    "militaryStatus" TEXT,
    "firstResponder" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pet" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "type" "PetType" NOT NULL,
    "name" TEXT,
    "breed" TEXT,
    "weightLbs" INTEGER,
    "leashTrained" BOOLEAN NOT NULL DEFAULT true,
    "comfortableInCrowds" BOOLEAN NOT NULL DEFAULT true,
    "comfortableAtNight" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TravelParty_tripId_key" ON "TravelParty"("tripId");

-- CreateIndex
CREATE INDEX "TravelParty_userId_idx" ON "TravelParty"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TravelParty_userId_isDefault_key" ON "TravelParty"("userId", "isDefault");

-- CreateIndex
CREATE INDEX "Person_partyId_idx" ON "Person"("partyId");

-- CreateIndex
CREATE INDEX "Pet_partyId_idx" ON "Pet"("partyId");

-- AddForeignKey
ALTER TABLE "TravelParty" ADD CONSTRAINT "TravelParty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelParty" ADD CONSTRAINT "TravelParty_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "TravelParty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pet" ADD CONSTRAINT "Pet_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "TravelParty"("id") ON DELETE CASCADE ON UPDATE CASCADE;
