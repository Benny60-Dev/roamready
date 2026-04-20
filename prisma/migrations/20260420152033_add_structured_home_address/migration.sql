-- AlterTable
ALTER TABLE "User" ADD COLUMN     "homeAddress" TEXT,
ADD COLUMN     "homeCity" TEXT,
ADD COLUMN     "homeLat" DOUBLE PRECISION,
ADD COLUMN     "homeLng" DOUBLE PRECISION,
ADD COLUMN     "homeState" TEXT,
ADD COLUMN     "homeStreet" TEXT,
ADD COLUMN     "homeZip" TEXT;
