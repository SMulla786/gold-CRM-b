import { Prisma } from '@prisma/client';
import { LEDGER_SOURCES } from '../shared';
import type { BalanceDto, LedgerSource } from '../shared';
import { HttpError } from '../middleware/error';
import { businessDate, type LedgerContext } from './ledger';
import type { ScopedDb } from './db';

/**
 * Party-balance ledger (docs/api-phase5.md). Sibling of lib/ledger.ts, but for what a PARTY owes the shop,
 * not the shop's own assets. Sign convention: + = party owes the shop, − = shop owes the party.
 * Append-only: corrections are negated reversal rows (reversalOfId, dated today). The only writer of UdharEntry.
 */

type Dec = Prisma.Decimal | string | number;
const D = (v: Dec | null | undefined) => new Prisma.Decimal(v === undefined || v === null || v === '' ? 0 : v);

export interface UdharEntryInput {
  branchId: number;
  partyId: number;
  /** business date; defaults to today in Asia/Kolkata */
  txnDate?: Date;
  amount?: Dec | null;
  gold?: Dec | null;
  silver?: Dec | null;
  source: LedgerSource;
  sourceId: string;
  narration?: string | null;
}

/** Writes party-balance rows for a document. Validates branch scope, source, and a non-zero movement. */
export async function post(tx: Prisma.TransactionClient, ctx: LedgerContext, entries: UdharEntryInput[]): Promise<void> {
  const today = businessDate();
  const data: Prisma.UdharEntryCreateManyInput[] = [];
  for (const e of entries) {
    if (!ctx.branchIds.includes(e.branchId)) throw new HttpError(404, 'NOT_FOUND', 'Udhar branch out of scope');
    if (!(LEDGER_SOURCES as readonly string[]).includes(e.source)) throw new HttpError(400, 'VALIDATION', `Invalid udhar source: ${e.source}`);
    const amount = D(e.amount);
    const gold = D(e.gold);
    const silver = D(e.silver);
    if (amount.isZero() && gold.isZero() && silver.isZero()) {
      throw new HttpError(400, 'VALIDATION', 'Udhar entry needs a non-zero amount, gold or silver');
    }
    data.push({
      businessId: ctx.businessId,
      branchId: e.branchId,
      partyId: e.partyId,
      txnDate: e.txnDate ?? today,
      amount,
      gold,
      silver,
      source: e.source,
      sourceId: e.sourceId,
      narration: e.narration ?? null,
      createdById: ctx.userId,
    });
  }
  if (data.length) await tx.udharEntry.createMany({ data });
}

/** Writes negated mirror rows (dated today, reversalOfId set) for every not-yet-reversed row of a document. */
export async function reverse(tx: Prisma.TransactionClient, ctx: LedgerContext, ref: { source: LedgerSource; sourceId: string }): Promise<void> {
  const rows = await tx.udharEntry.findMany({ where: { businessId: ctx.businessId, source: ref.source, sourceId: ref.sourceId, reversalOfId: null } });
  if (rows.length === 0) return;
  const alreadyReversed = new Set(
    (await tx.udharEntry.findMany({ where: { businessId: ctx.businessId, reversalOfId: { in: rows.map((r) => r.id) } }, select: { reversalOfId: true } })).map((r) => r.reversalOfId),
  );
  const today = businessDate();
  const data: Prisma.UdharEntryCreateManyInput[] = rows
    .filter((r) => !alreadyReversed.has(r.id))
    .map((r) => ({
      businessId: r.businessId,
      branchId: r.branchId,
      partyId: r.partyId,
      txnDate: today,
      amount: new Prisma.Decimal(r.amount).negated(),
      gold: new Prisma.Decimal(r.gold).negated(),
      silver: new Prisma.Decimal(r.silver).negated(),
      source: r.source,
      sourceId: r.sourceId,
      narration: `Reversal of #${r.id}`,
      reversalOfId: r.id,
      createdById: ctx.userId,
    }));
  if (data.length) await tx.udharEntry.createMany({ data });
}

const ZERO: BalanceDto = { amount: '0.00', gold: '0.000', silver: '0.000' };

/** Σ(amount, gold, silver) per party over the caller's scope — one groupBy. Parties with no rows → zero. */
export async function balances(db: ScopedDb, ctx: LedgerContext, partyIds: number[]): Promise<Map<number, BalanceDto>> {
  const out = new Map<number, BalanceDto>();
  if (partyIds.length === 0) return out;
  const grouped = await db.udharEntry.groupBy({
    by: ['partyId'],
    where: { businessId: ctx.businessId, partyId: { in: partyIds } }, // scopedDb also AND-s businessId + branchId
    _sum: { amount: true, gold: true, silver: true },
  });
  for (const g of grouped) {
    out.set(g.partyId, {
      amount: (g._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      gold: (g._sum.gold ?? new Prisma.Decimal(0)).toFixed(3),
      silver: (g._sum.silver ?? new Prisma.Decimal(0)).toFixed(3),
    });
  }
  for (const pid of partyIds) if (!out.has(pid)) out.set(pid, ZERO);
  return out;
}
