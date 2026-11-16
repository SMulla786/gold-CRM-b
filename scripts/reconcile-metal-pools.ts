/**
 * G7 review 6: READ-ONLY reconciliation of the KACHA / BULLION metal pools (lib/kacha). Lists every pool per business /
 * branch / metal / form; for each negative one, the totals by ledger source and the row where the running balance first
 * went below zero. Everything runs in a Postgres READ ONLY transaction: it cannot change the database, and it has no
 * --apply. The guards (poolGuard) stop new negatives; they do not repair history — run this before a deploy.
 *
 *   npx tsx --env-file=.env scripts/reconcile-metal-pools.ts [--rows]     --rows also prints every row of a negative pool
 */
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

export type PoolRow = { businessId: number; branchId: number; metal: string; form: string; bal: string; rows: number };
type Row = { id: bigint; createdAt: Date; txnDate: Date; direction: string; fine: string; source: string; sourceId: string; reversalOfId: bigint | null };
export type PoolLine = Row & { running: string };
export type NegativePool = PoolRow & { lines: PoolLine[]; bySource: Record<string, { in: string; out: string; rows: number }>; firstNegative: PoolLine | null };
export interface Reconciliation { readOnly: string; pools: PoolRow[]; negative: NegativePool[] }

/** Every pool, and each negative one row by row with its running balance — in ONE read-only transaction. */
export async function reconcileMetalPools(db: Pick<PrismaClient, '$transaction'>): Promise<Reconciliation> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const ro = (await tx.$queryRaw<{ ro: string }[]>`SELECT current_setting('transaction_read_only') AS ro`)[0]?.ro ?? 'off';
    const pools = await tx.$queryRaw<PoolRow[]>`
      SELECT "businessId", "branchId", asset::text AS metal, "metalForm"::text AS form, COUNT(*)::int AS rows,
             SUM(CASE WHEN direction = 'IN' THEN fine ELSE -fine END)::text AS bal
      FROM "LedgerEntry" WHERE asset::text IN ('GOLD', 'SILVER') AND "metalForm"::text IN ('KACHA', 'BULLION')
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`;
    const negative: NegativePool[] = [];
    for (const p of pools.filter((x) => Number(x.bal) < 0)) {
      const rows = await tx.$queryRaw<Row[]>`
        SELECT id, "createdAt", "txnDate", direction::text AS direction, fine::text AS fine, source, "sourceId", "reversalOfId"
        FROM "LedgerEntry" WHERE "businessId" = ${p.businessId} AND "branchId" = ${p.branchId}
          AND asset::text = ${p.metal} AND "metalForm"::text = ${p.form} ORDER BY "createdAt", id`;
      let run = 0;
      const by = new Map<string, { in: number; out: number; rows: number }>();
      const lines = rows.map((r) => {
        const f = Number(r.fine);
        run += r.direction === 'IN' ? f : -f;
        const k = r.source + (r.reversalOfId ? ' (reversal)' : '');
        const t = by.get(k) ?? { in: 0, out: 0, rows: 0 };
        t[r.direction === 'IN' ? 'in' : 'out'] += f;
        t.rows++;
        by.set(k, t);
        return { ...r, running: run.toFixed(3) };
      });
      const bySource = Object.fromEntries([...by].map(([k, t]) => [k, { in: t.in.toFixed(3), out: t.out.toFixed(3), rows: t.rows }]));
      negative.push({ ...p, lines, bySource, firstNegative: lines.find((l) => Number(l.running) < -0.0005) ?? null });
    }
    return { readOnly: ro, pools, negative };
  }, { timeout: 120_000 }); // Prisma's default 5 s interactive timeout aborts this read on a large ledger or a slow disk
}

async function main() {
  const r = await reconcileMetalPools(prisma);
  console.log(`${r.pools.length} pools, ${r.negative.length} negative`);
  for (const p of r.negative) {
    if (process.argv.includes('--rows')) for (const l of p.lines) console.log(`    #${l.id} ${l.createdAt.toISOString()} ${l.direction} ${l.fine} ${l.source} ${l.sourceId} → ${l.running}`);
    console.log(`NEGATIVE business ${p.businessId} branch ${p.branchId} ${p.metal} ${p.form}: ${Number(p.bal).toFixed(3)} g over ${p.rows} rows`);
    for (const [k, t] of Object.entries(p.bySource)) console.log(`  ${k}: in ${t.in} g, out ${t.out} g (${t.rows} rows)`);
    if (p.firstNegative) console.log(`  first went negative at row #${p.firstNegative.id} (${p.firstNegative.source} ${p.firstNegative.sourceId}, ${p.firstNegative.createdAt.toISOString()})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
