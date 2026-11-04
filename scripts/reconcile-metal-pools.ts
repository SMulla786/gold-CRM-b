/**
 * G7 review 6: READ-ONLY reconciliation of the KACHA / BULLION metal pools (lib/kacha). Lists every pool per business /
 * branch / metal / form; for each negative one, the totals by ledger source and the row where the running balance first
 * went below zero. Everything runs in a Postgres READ ONLY transaction: it cannot change the database, and it has no
 * --apply. The guards (poolGuard) stop new negatives; they do not repair history — run this before a deploy.
 *
 *   npx tsx --env-file=.env scripts/reconcile-metal-pools.ts [--rows]     --rows also prints every row of a negative pool
 */
import { prisma } from '../src/lib/prisma';

type Pool = { businessId: number; branchId: number; metal: string; form: string; bal: string; rows: number };
type Row = { id: bigint; createdAt: Date; txnDate: Date; direction: string; fine: string; source: string; sourceId: string; reversalOfId: bigint | null };

const showRows = process.argv.includes('--rows');
try {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const pools = await tx.$queryRaw<Pool[]>`
      SELECT "businessId", "branchId", asset::text AS metal, "metalForm"::text AS form, COUNT(*)::int AS rows,
             SUM(CASE WHEN direction = 'IN' THEN fine ELSE -fine END)::text AS bal
      FROM "LedgerEntry" WHERE asset::text IN ('GOLD', 'SILVER') AND "metalForm"::text IN ('KACHA', 'BULLION')
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`;
    const negative = pools.filter((p) => Number(p.bal) < 0);
    console.log(`${pools.length} pools, ${negative.length} negative`);
    for (const p of negative) {
      const rows = await tx.$queryRaw<Row[]>`
        SELECT id, "createdAt", "txnDate", direction::text AS direction, fine::text AS fine, source, "sourceId", "reversalOfId"
        FROM "LedgerEntry" WHERE "businessId" = ${p.businessId} AND "branchId" = ${p.branchId}
          AND asset::text = ${p.metal} AND "metalForm"::text = ${p.form} ORDER BY "createdAt", id`;
      let run = 0;
      let first: Row | null = null;
      const by = new Map<string, { in: number; out: number; rows: number }>();
      for (const r of rows) {
        const f = Number(r.fine);
        run += r.direction === 'IN' ? f : -f;
        if (run < -0.0005 && !first) first = r;
        const k = r.source + (r.reversalOfId ? ' (reversal)' : '');
        const t = by.get(k) ?? { in: 0, out: 0, rows: 0 };
        t[r.direction === 'IN' ? 'in' : 'out'] += f;
        t.rows++;
        by.set(k, t);
        if (showRows) console.log(`    #${r.id} ${r.createdAt.toISOString()} ${r.direction} ${r.fine} ${r.source} ${r.sourceId} → ${run.toFixed(3)}`);
      }
      console.log(`NEGATIVE business ${p.businessId} branch ${p.branchId} ${p.metal} ${p.form}: ${Number(p.bal).toFixed(3)} g over ${p.rows} rows`);
      for (const [k, t] of by) console.log(`  ${k}: in ${t.in.toFixed(3)} g, out ${t.out.toFixed(3)} g (${t.rows} rows)`);
      if (first) console.log(`  first went negative at row #${first.id} (${first.source} ${first.sourceId}, ${first.createdAt.toISOString()})`);
    }
  });
} finally {
  await prisma.$disconnect();
}
