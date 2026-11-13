-- Metas de ahorro de la pestaña Análisis
CREATE TABLE "savings_goals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "targetAmount" DECIMAL(12,2) NOT NULL,
    "initialSaved" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "targetMonth" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'DATE',
    "monthlyAmount" DECIMAL(12,2),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "savings_goals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "savings_contributions" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "savings_contributions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "savings_goals_userId_idx" ON "savings_goals"("userId");
CREATE INDEX "savings_contributions_goalId_idx" ON "savings_contributions"("goalId");

ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "savings_contributions" ADD CONSTRAINT "savings_contributions_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "savings_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
