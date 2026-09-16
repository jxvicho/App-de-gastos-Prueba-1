-- CreateEnum
CREATE TYPE "PetType" AS ENUM ('dog', 'cat', 'capybara', 'pig', 'none');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "petName" VARCHAR(15) DEFAULT 'Gastón',
ADD COLUMN     "petType" "PetType" NOT NULL DEFAULT 'dog';
