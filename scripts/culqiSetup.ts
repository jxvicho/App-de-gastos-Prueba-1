/**
 * Crea (una sola vez) en Culqi los planes de Gastia: Básico y Pro × mensual, trimestral y anual × con/sin prueba
 * de 7 días (12 planes) y guarda sus ids en la tabla billing_plans. Es seguro repetirlo: lo ya creado se omite.
 *
 * Uso (con CULQI_SECRET_KEY y CULQI_PUBLIC_KEY de pruebas en el .env):
 *   docker compose exec backend npx tsx scripts/culqiSetup.ts
 *
 * Después de correrlo en sandbox, ENTRA AL CULQIPANEL (modo integración) > Suscripciones > Planes y verifica que cada plan
 * muestre la frecuencia correcta (cada 1 / 3 / 12 meses) y los 7 días de prueba. Si no coinciden, corrige
 * CULQI_PATHS / CULQI_UNIT en src/services/culqi.ts, borra las filas de billing_plans y vuelve a correrlo.
 */
import { prisma } from "../src/config/prisma";
import { BILLING_PERIODS, SELLABLE_PLANS } from "../src/config/plans";
import { ensureBillingPlan, paymentsAvailable } from "../src/services/billing";
import { isCulqiConfigured } from "../src/services/culqi";

async function main() {
  if (!isCulqiConfigured()) {
    console.error("Faltan CULQI_SECRET_KEY y/o CULQI_PUBLIC_KEY en el .env.");
    process.exit(1);
  }
  if (!paymentsAvailable()) console.warn("Aviso: PAYMENTS_ENABLED=false. Los planes se crean igual; el cobro sigue apagado en la app.");

  for (const plan of SELLABLE_PLANS) {
    for (const period of BILLING_PERIODS) {
      for (const withTrial of [true, false]) {
        const row = await ensureBillingPlan(plan, period, withTrial);
        console.log(`${plan.padEnd(5)} ${period.padEnd(9)} ${withTrial ? "con prueba" : "sin prueba"}  →  ${row.culqiPlanId}  (S/ ${(row.amountCents / 100).toFixed(2)})`);
      }
    }
  }
  console.log("\nListo. Verifica los planes en el CulqiPanel (ver comentario al inicio de este archivo).");
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
