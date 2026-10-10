ALTER TABLE "users" ADD COLUMN "dailySummaryEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "recurring_payments" ADD COLUMN "merchantKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "recurring_payments" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'DETECTED';
ALTER TABLE "recurring_payments" ADD COLUMN "ignored" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "recurring_payments" ADD COLUMN "categoryId" TEXT;
CREATE UNIQUE INDEX "recurring_payments_userId_merchantKey_currency_key" ON "recurring_payments"("userId", "merchantKey", "currency");

CREATE TABLE "category_goals" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'PEN',
  "amount" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "category_goals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "category_goals_userId_categoryId_currency_key" ON "category_goals"("userId", "categoryId", "currency");
ALTER TABLE "category_goals" ADD CONSTRAINT "category_goals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "category_goals" ADD CONSTRAINT "category_goals_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TABLE "subscriptions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
  "trialStartedAt" TIMESTAMP(3),
  "trialEndsAt" TIMESTAMP(3),
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "paymentBrand" TEXT,
  "paymentLast4" TEXT,
  "paymentExpMonth" INTEGER,
  "paymentExpYear" INTEGER,
  "billingName" TEXT,
  "billingDocType" TEXT,
  "billingDocNumber" TEXT,
  "billingEmail" TEXT,
  "billingAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subscriptions_userId_key" ON "subscriptions"("userId");
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
