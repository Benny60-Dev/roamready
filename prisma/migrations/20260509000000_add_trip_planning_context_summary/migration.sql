-- AlterEnum
ALTER TYPE "AICallType" ADD VALUE 'PLANNING_SUMMARY';

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "planningContextSummary" TEXT;
