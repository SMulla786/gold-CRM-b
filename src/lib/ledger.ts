import type { LedgerEntry, Prisma } from '@prisma/client';
import { LEDGER_SOURCES } from '../shared';
import type { LedgerAsset, LedgerSource, StockClass } from '../shared';
import { HttpError } from '../middleware/error';

/**
 * Ledger posting core (rebuild-notes §5 / docs/api-phase2.md). The ONLY writer of LedgerEntry.
 * Call inside the same prisma.$transaction as the document. Rows are never updated/deleted —
 * corrections are reversal rows (direction flipped, reversalOfId set, dated TODAY). Edits = reverse + post new.
 */

export interface LedgerContext {
  businessId: number;
  branchIds: number[];
  userId: number;
}

/** Weights/amounts pass through as strings or Decimal (calc engine returns strings) — never round-tripped through JS number. */
type Dec = Prisma.Decimal | string | number;

export interface LedgerEntryInput {
  branchId: number;
  /** business date (Day-Book date); defaults to today in Asia/Kolkata */
  txnDate?: Date;
  asset: LedgerAsset;
  direction: 'IN' | 'OUT';
  bankAccountId?: number | null;
  metalForm?: 'USUAL' | 'BULLION' | 'KACHA' | null;
  karatCode?: string | null;
  pcs?: number | null;
  gross?: Dec | null;
  net?: Dec | null;
  fine?: Dec | null;
  amount?: Dec | null;
  source: LedgerSource;
  sourceId: string;
  partyId?: number | null;
  stockItemId?: number | null;
  narration?: string | null;
}

const STOCK_CLASS_ASSET: Record<StockClass, LedgerAsset> = { GOLD: 'GOLD', SILVER: 'SILVER', STONE: 'STONE', ARTIFICIAL: 'ARTIFICIAL', FRANCHISE: 'FRANCHISE' };
export const assetForStockClass = (c: StockClass): LedgerAsset => STOCK_CLASS_ASSET[c];

/** The business (Day-Book) date for a moment, in Asia/Kolkata, as a UTC-midnight Date for a @db.Date column. */
export function businessDate(d: Date = new Date()): Date {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return new Date(`${s}T00:00:00Z`);
}

/** Writes ledger rows for a document. Validates branch scope, source, and per-asset required fields. */
export async function post(tx: Prisma.TransactionClient, ctx: LedgerContext, entries: LedgerEntryInput[]): Promise<void> {
  const today = businessDate();
  const data: Prisma.LedgerEntryCreateManyInput[] = [];
  for (const e of entries) {
    if (!ctx.branchIds.includes(e.branchId)) throw new HttpError(404, 'NOT_FOUND', 'Ledger branch out of scope');
    if (!(LEDGER_SOURCES as readonly string[]).includes(e.source)) throw new HttpError(400, 'VALIDATION', `Invalid ledger source: ${e.source}`);
    if (e.asset === 'MONEY') {
      if (e.amount == null) throw new HttpError(400, 'VALIDATION', 'MONEY ledger entry needs amount');
    } else if (e.fine == null || e.net == null) {
      throw new HttpError(400, 'VALIDATION', `${e.asset} ledger entry needs net and fine`);
    }
    data.push({
      businessId: ctx.businessId,
      branchId: e.branchId,
      txnDate: e.txnDate ?? today,
      asset: e.asset,
      direction: e.direction,
      bankAccountId: e.bankAccountId ?? null,
      metalForm: e.metalForm ?? null,
      karatCode: e.karatCode ?? null,
      pcs: e.pcs ?? null,
      gross: e.gross ?? null,
      net: e.net ?? null,
      fine: e.fine ?? null,
      amount: e.amount ?? null,
      source: e.source,
      sourceId: e.sourceId,
      partyId: e.partyId ?? null,
      stockItemId: e.stockItemId ?? null,
      narration: e.narration ?? null,
      createdById: ctx.userId,
    });
  }
  if (data.length) await tx.ledgerEntry.createMany({ data });
}

/** Writes mirror rows (direction flipped, dated today, reversalOfId set) for the given active rows, skipping any already reversed. */
async function writeReversals(tx: Prisma.TransactionClient, ctx: LedgerContext, rows: LedgerEntry[]): Promise<void> {
  if (rows.length === 0) return;
  const alreadyReversed = new Set(
    (await tx.ledgerEntry.findMany({ where: { businessId: ctx.businessId, reversalOfId: { in: rows.map((r) => r.id) } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId),
  );
  const today = businessDate();
  const data: Prisma.LedgerEntryCreateManyInput[] = rows
    .filter((r) => !alreadyReversed.has(r.id))
    .map((r) => ({
      businessId: r.businessId,
      branchId: r.branchId,
      txnDate: today, // corrections land on today's Day-Book, never a closed past day
      asset: r.asset,
      direction: r.direction === 'IN' ? 'OUT' : 'IN',
      bankAccountId: r.bankAccountId,
      metalForm: r.metalForm,
      karatCode: r.karatCode,
      pcs: r.pcs,
      gross: r.gross,
      net: r.net,
      fine: r.fine,
      amount: r.amount,
      source: r.source,
      sourceId: r.sourceId,
      partyId: r.partyId,
      stockItemId: r.stockItemId,
      narration: `Reversal of #${r.id}`,
      reversalOfId: r.id,
      createdById: ctx.userId,
    }));
  if (data.length) await tx.ledgerEntry.createMany({ data });
}

/** Reverse every not-yet-reversed row of a document (by source + sourceId). */
export async function reverse(tx: Prisma.TransactionClient, ctx: LedgerContext, ref: { source: LedgerSource; sourceId: string }): Promise<void> {
  await writeReversals(tx, ctx, await tx.ledgerEntry.findMany({ where: { businessId: ctx.businessId, source: ref.source, sourceId: ref.sourceId, reversalOfId: null } }));
}

/** Reverse every active row touching a stock item, whatever its source (insert, transfer OUT/IN). Used by stock edit/delete so a transferred item nets to zero across both branches. */
export async function reverseForItem(tx: Prisma.TransactionClient, ctx: LedgerContext, stockItemId: number): Promise<void> {
  await writeReversals(tx, ctx, await tx.ledgerEntry.findMany({ where: { businessId: ctx.businessId, stockItemId, reversalOfId: null } }));
}
