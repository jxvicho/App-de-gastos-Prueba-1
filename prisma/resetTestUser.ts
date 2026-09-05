import { PrismaClient } from "@prisma/client";
import { DEFAULT_CATEGORIES } from "../src/utils/defaultCategories";

const prisma = new PrismaClient();

const TEST_EMAIL = "javier@test.com";

function sampleTransactions(categoryIdByName: Record<string, string>) {
  const today = new Date();
  const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000);

  return [
    { desc: "Juan Pérez Rojas", amount: 5, days: 1, cat: "Yape / Plin", type: "EXPENSE" as const },
    { desc: "María Gómez Torres", amount: 12, days: 2, cat: "Yape / Plin", type: "EXPENSE" as const },
    { desc: "Carlos Ramírez Vidal", amount: 3, days: 3, cat: "Yape / Plin", type: "EXPENSE" as const },
    { desc: "Ana Flores Castro", amount: 20, days: 5, cat: "Yape / Plin", type: "EXPENSE" as const },
    { desc: "Luis Mendoza Ríos", amount: 8, days: 7, cat: "Yape / Plin", type: "EXPENSE" as const },
    { desc: "Mercado Central", amount: 45.5, days: 1, cat: "Alimentación", type: "EXPENSE" as const },
    { desc: "Panadería San José", amount: 12.9, days: 4, cat: "Alimentación", type: "EXPENSE" as const },
    { desc: "Restaurante El Buen Sabor", amount: 68, days: 9, cat: "Alimentación", type: "EXPENSE" as const },
    { desc: "Compañía Eléctrica Regional", amount: 120, days: 6, cat: "Servicios y utilities", type: "EXPENSE" as const },
    { desc: "Agua y Saneamiento Municipal", amount: 55, days: 6, cat: "Servicios y utilities", type: "EXPENSE" as const },
    { desc: "Compañía de Telefonía Norte", amount: 89.9, days: 10, cat: "Servicios y utilities", type: "EXPENSE" as const },
    { desc: "Librería Horizonte", amount: 34, days: 3, cat: "Otros comercios", type: "EXPENSE" as const },
    { desc: "Tienda de Ropa Andina", amount: 150, days: 12, cat: "Otros comercios", type: "EXPENSE" as const },
    { desc: "Taxi Express Ruta 5", amount: 18.5, days: 2, cat: "Transporte", type: "EXPENSE" as const },
    { desc: "App de Transporte Urbano", amount: 9.9, days: 4, cat: "Transporte", type: "EXPENSE" as const },
    { desc: "Botica Vida Sana", amount: 42, days: 8, cat: "Salud", type: "EXPENSE" as const },
    { desc: "Clínica del Norte", amount: 95, days: 15, cat: "Salud", type: "EXPENSE" as const },
    { desc: "Pago de Tarjeta de Crédito", amount: 850, days: 5, cat: "Movimientos financieros", type: "EXPENSE" as const },
    { desc: "Transferencia entre cuentas propias", amount: 3000, days: 5, cat: "No considerar", type: "EXPENSE" as const },
    { desc: "Depósito de honorarios", amount: 2500, days: 6, cat: "Ingresos", type: "INCOME" as const },
    { desc: "Transferencia de familiar", amount: 200, days: 11, cat: "Ingresos", type: "INCOME" as const },
  ].map((t) => ({
    merchant: t.desc,
    amount: t.amount,
    type: t.type,
    categoryId: categoryIdByName[t.cat],
    occurredAt: daysAgo(t.days),
    source: "CSV_IMPORT" as const,
    status: "CONFIRMED" as const,
    confirmedAt: new Date(),
    currency: "PEN",
  }));
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (!user) {
    console.error(`No existe ningún usuario con el correo ${TEST_EMAIL}`);
    process.exit(1);
  }

  console.log(`Reseteando categorías y datos de ejemplo para ${TEST_EMAIL}...`);

  await prisma.transaction.deleteMany({ where: { userId: user.id } });
  await prisma.category.deleteMany({ where: { userId: user.id } });

  const created = await Promise.all(
    DEFAULT_CATEGORIES.map((c) =>
      prisma.category.create({
        data: { ...c, userId: user.id, isDefault: true },
      })
    )
  );

  const categoryIdByName: Record<string, string> = {};
  created.forEach((c) => (categoryIdByName[c.name] = c.id));

  const txns = sampleTransactions(categoryIdByName);
  await prisma.transaction.createMany({ data: txns.map((t) => ({ ...t, userId: user.id })) });

  console.log(`✅ Listo: ${created.length} categorías y ${txns.length} movimientos de ejemplo cargados.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
