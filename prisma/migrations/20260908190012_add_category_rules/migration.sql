-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('MERCHANT_CONTAINS', 'AMOUNT_GREATER_THAN', 'AMOUNT_LESS_THAN', 'AMOUNT_EQUALS');

-- CreateEnum
CREATE TYPE "RuleSource" AS ENUM ('WHATSAPP', 'DASHBOARD');

-- CreateTable
CREATE TABLE "category_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "RuleType" NOT NULL,
    "value" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "source" "RuleSource" NOT NULL DEFAULT 'DASHBOARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_rules_userId_isActive_idx" ON "category_rules"("userId", "isActive");

-- AddForeignKey
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

