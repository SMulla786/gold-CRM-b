import { Prisma } from '@prisma/client';
import { HttpError } from '../middleware/error';
import type { Metal } from '../shared';

/**
 * Bulk old/kacha & refined bullion metal is a ledger weight balance (LedgerEntry.metalForm KACHA|BULLION on
 * the GOLD/SILVER asset), not StockItem rows. Net available = Σ(IN − OUT) of fine over those rows for a branch.
 * branchId is globally unique (one business), so it alone is a safe tenant key here.
 */

/** Any Prisma client that can run raw SQL — a $transaction client or the shared db. */
type Queryer = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** Stable second advisory-lock key per metal (pg_advisory_xact_lock takes two int4 keys). */
const metalKey = (metal: Metal): number => (metal === 'GOLD' ? 1 : 2);

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

/**
 * Guard a kacha draw (MELT/REFINE, exchange SELL, and exchange DELETE reversals): takes a per-(branch, metal)
 * advisory xact lock so concurrent draws on the same pool serialize, then 409s if available kacha fine < `fine`.
 * MUST run inside a $transaction (the xact lock releases on commit/rollback).
 */
export async function assertKachaAvailable(tx: Queryer, branchId: number, metal: Metal, fine: Prisma.Decimal | string | number): Promise<void> {
  const bal = await lockedKacha(tx, branchId, metal);
  const need = new Prisma.Decimal(fine);
  if (bal.lessThan(need)) throw new HttpError(409, 'CONFLICT', `Not enough kacha ${metal.toLowerCase()}: have ${bal.toString()}g, need ${need.toString()}g`);
}

/** Takes the per-(branch, metal) pool lock (held until the transaction ends) and returns the kacha fine balance. $transaction only. */
export async function lockedKacha(tx: Queryer, branchId: number, metal: Metal): Promise<Prisma.Decimal> {
  // $executeRaw (not $queryRaw): the lock returns void, which $queryRaw can't deserialize. ::int4 — Prisma binds
  // JS numbers as bigint, and only the two-key pg_advisory_xact_lock(int4, int4) overload fits a (branch, metal) pair.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${branchId}::int4, ${metalKey(metal)}::int4)`);
  return new Prisma.Decimal((await kachaBalance(tx, branchId, metal)).kacha);
}
