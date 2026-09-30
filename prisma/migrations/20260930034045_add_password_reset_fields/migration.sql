-- AlterTable
ALTER TABLE "users" ADD COLUMN     "resetPasswordExpiresAt" TIMESTAMP(3),
ADD COLUMN     "resetPasswordTokenHash" TEXT;
