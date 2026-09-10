-- CreateIndex
CREATE UNIQUE INDEX "budgets_userId_scope_periodStart_periodEnd_currency_key" ON "budgets"("userId", "scope", "periodStart", "periodEnd", "currency");

