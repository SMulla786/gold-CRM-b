import { PrismaClient } from '@prisma/client';

export const db = new PrismaClient();

/** Wipe all data between tests (schema stays). TRUNCATE ... CASCADE is order-independent. */
export async function truncateAll(): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
