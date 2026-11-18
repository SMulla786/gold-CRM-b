/**
 * Idempotent seed (`npm run db:seed`): the base data in ./seed-base.ts — states, districts, permission catalog, system roles,
 * plans, HSN, super admin. SEED_DEMO=true also creates a demo business with a small branch tree and users (password = SEED_SUPERADMIN_PASSWORD).
 */
import { PrismaClient } from '@prisma/client';
import { seedPasswordHash } from './seed-password';
import { seedBase } from './seed-base';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await seedPasswordHash(); // first: a refused password must leave the DB untouched
  const { districts: d } = await seedBase(prisma, { passwordHash, demo: process.env.SEED_DEMO === 'true' });
  console.log(`Districts: ${d.created} created, ${d.updated.length} updated, ${d.unchanged} unchanged, ${d.notInSource.length} kept (not in LGD)`);
  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
