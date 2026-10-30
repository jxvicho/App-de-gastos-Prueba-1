-- Aditiva: campos de pasarela (Culqi) en subscriptions y tablas de planes, cobros y eventos.
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

ALTER TABLE "subscriptions" ADD COLUMN "billingPeriod" "BillingPeriod";
ALTER TABLE "subscriptions" ADD COLUMN "culqiCustomerId" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "culqiCardId" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "culqiSubscriptionId" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "failedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscriptions" ADD COLUMN "restrictedAt" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN "canceledAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "subscriptions_culqiSubscriptionId_key" ON "subscriptions"("culqiSubscriptionId");

CREATE TABLE "billing_plans" (
  "id" TEXT NOT NULL,
  "plan" "Plan" NOT NULL,
  "period" "BillingPeriod" NOT NULL,
  "withTrial" BOOLEAN NOT NULL,
  "culqiPlanId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_plans_plan_period_withTrial_key" ON "billing_plans"("plan", "period", "withTrial");

CREATE TABLE "billing_charges" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "culqiChargeId" TEXT NOT NULL,
  "culqiSubscriptionId" TEXT,
  "status" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PEN',
  "period" "BillingPeriod",
  "failureMessage" TEXT,
  "refundedAt" TIMESTAMP(3),
  "culqiRefundId" TEXT,
  "receiptStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_charges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "billing_charges_culqiChargeId_key" ON "billing_charges"("culqiChargeId");
CREATE INDEX "billing_charges_userId_createdAt_idx" ON "billing_charges"("userId", "createdAt");
ALTER TABLE "billing_charges" ADD CONSTRAINT "billing_charges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "billing_events" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);
