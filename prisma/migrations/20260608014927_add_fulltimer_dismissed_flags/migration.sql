-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dismissedHomePrompt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isFullTimeRVer" BOOLEAN NOT NULL DEFAULT false;
