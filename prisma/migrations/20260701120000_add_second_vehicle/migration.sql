-- CreateTable
CREATE TABLE "SecondVehicle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "towedType" "TowedType" NOT NULL,
    "year" INTEGER,
    "make" TEXT,
    "model" TEXT,
    "length" DOUBLE PRECISION,
    "height" DOUBLE PRECISION,
    "licensePlate" TEXT,
    "fuelType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecondVehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecondVehicle_userId_idx" ON "SecondVehicle"("userId");

-- AddForeignKey
ALTER TABLE "SecondVehicle" ADD CONSTRAINT "SecondVehicle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
