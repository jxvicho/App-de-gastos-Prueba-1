-- DropForeignKey
ALTER TABLE "rules" DROP CONSTRAINT "rules_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "rules" DROP CONSTRAINT "rules_userId_fkey";

-- DropTable
DROP TABLE "rules";

