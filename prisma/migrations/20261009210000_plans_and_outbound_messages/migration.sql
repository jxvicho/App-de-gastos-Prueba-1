-- Planes, consentimiento, resumen diario y registro de mensajes salientes.
CREATE TYPE "Plan" AS ENUM ('BASIC', 'PRO', 'UNLIMITED');

-- El reporte diario de la migración anterior pasa a los nombres definitivos.
ALTER TABLE "users" RENAME COLUMN "dailyReportEnabled" TO "whatsappOptIn";
ALTER TABLE "users" RENAME COLUMN "dailyReportHour" TO "dailySummaryHour";

ALTER TABLE "users" ADD COLUMN "plan" "Plan" NOT NULL DEFAULT 'BASIC';
ALTER TABLE "users" ADD COLUMN "planOverride" "Plan";
ALTER TABLE "users" ADD COLUMN "planOverrideUntil" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "alertThreshold" DECIMAL(14,2);
ALTER TABLE "users" ADD COLUMN "lastInboundAt" TIMESTAMP(3);

-- Los usuarios que ya existen (dueño, equipo y testers) conservan el comportamiento actual.
UPDATE "users" SET "plan" = 'UNLIMITED';

CREATE TABLE "promos" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "appliesTo" "Plan"[],
  "grantsPlan" "Plan" NOT NULL DEFAULT 'PRO',
  "uncapped" BOOLEAN NOT NULL DEFAULT true,
  "budgetUsd" DECIMAL(12,4) NOT NULL,
  "spentUsd" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promos_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbound_messages" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "wamid" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "isTemplate" BOOLEAN NOT NULL DEFAULT false,
  "category" TEXT,
  "billable" BOOLEAN,
  "pricingType" TEXT,
  "costUsd" DECIMAL(10,5),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outbound_messages_wamid_key" ON "outbound_messages"("wamid");
CREATE INDEX "outbound_messages_userId_createdAt_idx" ON "outbound_messages"("userId", "createdAt");
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
