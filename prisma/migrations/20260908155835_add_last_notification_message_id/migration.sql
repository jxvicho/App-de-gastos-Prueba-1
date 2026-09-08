-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "lastNotificationMessageId" TEXT;

-- CreateIndex
CREATE INDEX "transactions_lastNotificationMessageId_idx" ON "transactions"("lastNotificationMessageId");
