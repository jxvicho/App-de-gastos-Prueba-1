-- CreateIndex
CREATE UNIQUE INDEX "transactions_userId_rawEmailId_key" ON "transactions"("userId", "rawEmailId");
