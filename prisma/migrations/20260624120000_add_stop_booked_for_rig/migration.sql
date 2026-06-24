-- AlterTable
ALTER TABLE "Stop" ADD COLUMN     "bookedForRigAt" TIMESTAMP(3),
ADD COLUMN     "bookedForRigHeight" DOUBLE PRECISION,
ADD COLUMN     "bookedForRigLength" DOUBLE PRECISION,
ADD COLUMN     "bookedForRigName" TEXT,
ADD COLUMN     "bookedForRigTowedLength" DOUBLE PRECISION,
ADD COLUMN     "bookedForRigType" "VehicleType",
ADD COLUMN     "bookedForRigWeight" DOUBLE PRECISION;
