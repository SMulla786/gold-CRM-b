import { Prisma } from '@prisma/client';
import { HttpError } from '../middleware/error';
import type { Metal } from '../shared';

/**
 * Bulk old/kacha & refined bullion metal is a ledger weight balance (LedgerEntry.metalForm KACHA|BULLION on
 * the GOLD/SILVER asset), not StockItem rows. Net available = Σ(IN − OUT) of fine over those rows for a branch.
 * branchId is globally unique (one business), so it alone is a safe tenant key here.
 *
 * GLOBAL LOCK ORDER for every money/metal write that touches these pools (G5):
 *   1. the document row (bill / exchange / buy-sell / kacha process; opening: its ledger rows), FOR UPDATE or a guarded update;
 *   2. the branch pool locks, via poolGuard only: GOLD before SILVER, KACHA before BULLION within a metal;
 *   3. child / related rows.
 * Everyone taking the locks in this order is what rules out deadlocks between bills, exchange, melt and opening.
 */

/** Any Prisma client that can run raw SQL — a $transaction client or the shared db. */
type Queryer = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export type PoolForm = 'KACHA' | 'BULLION';
export interface Pool { metal: Metal; form: PoolForm }

/** Second advisory-lock key per pool; ascending order = the global order (gold kacha, gold bullion, silver kacha, silver bullion). */
const poolKey = (p: Pool): number => (p.metal === 'GOLD' ? 0 : 2) + (p.form === 'KACHA' ? 1 : 2);

/** KACHA and BULLION net fine for a branch's metal pool (powers the two stock cards). */
export async function kachaBalance(client: Queryer, branchId: number, metal: Metal): Promise<{ kacha: string; bullion: string }> {
  const rows = await client.$queryRaw<{ form: string; bal: Prisma.Decimal }[]>(Prisma.sql`
    SELECT "metalForm"::text AS form, COALESCE(SUM(CASE WHEN direction = 'IN' THEN fine ELSE -fine END), 0)::numeric AS bal
    FROM "LedgerEntry"
    WHERE "branchId" = ${branchId} AND asset::text = ${metal} AND "metalForm"::text IN ('KACHA', 'BULLION')
    GROUP BY "metalForm"`);
  const of = (f: string) => (rows.find((r) => r.form === f)?.bal ?? new Prisma.Decimal(0)).toString();
  return { kacha: of('KACHA'), bullion: of('BULLION') };
}

/** G5: kacha reserved by open PROCESS batches = Σ their fine − Σ the fine their active refines already took. */
export async function reservedKacha(client: Queryer, branchId: number, metal: Metal): Promise<Prisma.Decimal> {
  const rows = await client.$queryRaw<{ r: Prisma.Decimal | null }[]>(Prisma.sql`
    SELECT COALESCE(SUM(GREATEST(p."inFine" - COALESCE((SELECT SUM(c."inFine") FROM "KachaProcess" c WHERE c."parentId" = p.id AND NOT c.reverted), 0), 0)), 0)::numeric AS r
    FROM "KachaProcess" p WHERE p."branchId" = ${branchId} AND p.metal::text = ${metal} AND p.type::text = 'PROCESS' AND NOT p.reverted`);
  return new Prisma.Decimal(rows[0]?.r ?? 0);
}

/** What a guard may draw: bullion = its ledger balance; kacha = ledger balance less what PROCESS batches reserve. */
const poolBalance = async (client: Queryer, branchId: number, p: Pool) => {
  const b = await kachaBalance(client, branchId, p.metal);
  return p.form === 'BULLION' ? new Prisma.Decimal(b.bullion) : new Prisma.Decimal(b.kacha).minus(await reservedKacha(client, branchId, p.metal));
};

// $executeRaw (not $queryRaw): the lock returns void, which $queryRaw can't deserialize. ::int4 — Prisma binds JS numbers
// as bigint, and only the two-key pg_advisory_xact_lock(int4, int4) overload fits a (branch, pool) pair. Held until commit.
const lockPool = (tx: Queryer, branchId: number, p: Pool) => tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${branchId}::int4, ${poolKey(p)}::int4)`);

/** One pool per (metal, form), sorted into the global lock order. */
export function sortedPools(pools: Pool[]): Pool[] {
  const seen = new Map(pools.map((p) => [poolKey(p), p]));
  return [...seen.keys()].sort((a, b) => a - b).map((k) => seen.get(k)!);
}

/** Pools a set of metal rows / payments touches (anything with metal + metalForm KACHA|BULLION). */
export const poolsOf = (...rows: { metal?: string | null; metalForm?: string | null }[][]): Pool[] =>
  sortedPools(rows.flat().filter((r) => (r.metalForm === 'KACHA' || r.metalForm === 'BULLION') && (r.metal === 'GOLD' || r.metal === 'SILVER')).map((r) => ({ metal: r.metal as Metal, form: r.metalForm as PoolForm })));

export interface PoolUse { source: string; sourceId: string; txnDate: string; fine: string }

/**
 * The one lock-and-check for KACHA / BULLION (ACC-05, G5). Call BEFORE the writes, inside the transaction and after the
 * document row lock: locks every pool in the global order and notes its balance. Run the returned check AFTER the writes:
 * a pool may not end below zero, and one that was already negative (legacy data) may not get worse → 409
 * `KACHA_SHORT` / `BULLION_SHORT`. `usedBy` (optional) names what drew the metal since — used when a reversal is refused.
 */
export async function poolGuard(tx: Queryer, branchId: number, pools: Pool[], usedBy?: (p: Pool) => Promise<PoolUse[]>): Promise<() => Promise<void>> {
  const list = sortedPools(pools);
  const before: Prisma.Decimal[] = [];
  for (const p of list) {
    await lockPool(tx, branchId, p);
    before.push(await poolBalance(tx, branchId, p));
  }
  return async () => {
    for (const [i, p] of list.entries()) {
      const was = before[i]!;
      const now = await poolBalance(tx, branchId, p);
      if (now.gte(0) || now.gte(was)) continue;
      const used = usedBy ? await usedBy(p) : [];
      const why = used.length ? `; it was used since by ${used.map((u) => `${u.source} ${u.sourceId} (${u.txnDate}, ${u.fine} g)`).join(', ')} — revert those first` : '';
      throw new HttpError(409, 'CONFLICT', `Not enough ${p.form.toLowerCase()} ${p.metal.toLowerCase()}: the pool holds ${was.toFixed(3)} g and this change takes ${was.minus(now).toFixed(3)} g${why}`, {
        code: `${p.form}_SHORT`, metal: p.metal, form: p.form, available: was.toFixed(3), needed: was.minus(now).toFixed(3), usedBy: used,
      });
    }
  };
}

/**
 * Guard a kacha draw of a known size (kept for callers that check before writing): takes the pool lock, 409 if the kacha
 * balance < `fine`. MUST run inside a $transaction.
 */
export async function assertKachaAvailable(tx: Queryer, branchId: number, metal: Metal, fine: Prisma.Decimal | string | number): Promise<void> {
  const bal = await lockedKacha(tx, branchId, metal);
  const need = new Prisma.Decimal(fine);
  if (bal.lessThan(need)) throw new HttpError(409, 'CONFLICT', `Not enough kacha ${metal.toLowerCase()}: have ${bal.toString()}g, need ${need.toString()}g`);
}

/** Takes the (branch, metal) KACHA pool lock and returns its balance. $transaction only. */
export async function lockedKacha(tx: Queryer, branchId: number, metal: Metal): Promise<Prisma.Decimal> {
  const p: Pool = { metal, form: 'KACHA' };
  await lockPool(tx, branchId, p);
  return poolBalance(tx, branchId, p);
}
