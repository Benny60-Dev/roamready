-- CreateEnum
CREATE TYPE "TowedType" AS ENUM ('VEHICLE', 'TRAILER');

-- AlterTable
ALTER TABLE "Rig" ADD COLUMN     "isTowing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "licensePlate" TEXT,
ADD COLUMN     "towedLength" DOUBLE PRECISION,
ADD COLUMN     "towedLicensePlate" TEXT,
ADD COLUMN     "towedMake" TEXT,
ADD COLUMN     "towedModel" TEXT,
ADD COLUMN     "towedType" "TowedType",
ADD COLUMN     "towedYear" INTEGER;
