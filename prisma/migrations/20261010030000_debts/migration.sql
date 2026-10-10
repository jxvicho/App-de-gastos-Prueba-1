CREATE TABLE "debts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "counterparty" TEXT NOT NULL,
  "concept" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PEN',
  "dueDate" TIMESTAMP(3),
  "phone" TEXT,
  "settledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "debts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "debts_userId_direction_idx" ON "debts"("userId", "direction");
ALTER TABLE "debts" ADD CONSTRAINT "debts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "debt_payments" (
  "id" TEXT NOT NULL,
  "debtId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "debt_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "debt_payments_debtId_idx" ON "debt_payments"("debtId");
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "debts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
