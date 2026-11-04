/**
 * G7 review 2: load / refresh the India district master (LGD) — see prisma/data/README.md.
 *
 *   npx tsx --env-file=.env scripts/import-districts.ts            dry run: prints what would change, writes nothing
 *   npx tsx --env-file=.env scripts/import-districts.ts --apply    writes it, in one transaction
 *
 * Idempotent: a second --apply reports 0 created / 0 updated. Never deletes a district (kept ones are listed).
 * Needs the State rows first (prisma db seed). Back up the database before --apply on a real one.
 */
import { prisma } from '../src/lib/prisma';
import { importDistricts } from '../prisma/districts';

const apply = process.argv.includes('--apply');
try {
  const r = await importDistricts(prisma, { apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN (nothing written; pass --apply)'} — source rows ${r.sourceRows}`);
  console.log(`created ${r.created} · updated ${r.updated.length} · unchanged ${r.unchanged} · kept (not in source) ${r.notInSource.length}`);
  for (const u of r.updated) console.log(`  update #${u.id}: ${u.from} → ${u.to}`);
  for (const k of r.notInSource) console.log(`  kept #${k.id}: state ${k.stateId} "${k.name}" (${k.references} references)`);
} finally {
  await prisma.$disconnect();
}
