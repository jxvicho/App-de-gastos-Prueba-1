import { prisma } from "./prisma";

export async function keepDatabaseAwake(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
