import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import * as ledger from '../../lib/ledger';
import * as udhar from '../../lib/udhar';
import { logActivity } from '../../lib/activity';
import { HttpError } from '../../middleware/error';
import type { TenantContext } from '../../middleware/context';
import { moneyToMetal } from '../../shared';
import type {
  BalanceDto,
  BillListItemDto,
  LedgerSource,
  PartyBalanceRowDto,
  PartyRefDto,
  PartyType,
  Paged,
  PendingBillsSummaryDto,
  StatementDto,
  InlineUdharInput,
  TradeUdharDto,
  UdharBody,
  UdharEntryRowDto,
  UdharTxnDto,
} from '../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (d: Prisma.Decimal) => d.toFixed(2);
const wt = (d: Prisma.Decimal) => d.toFixed(3);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const PARTY_SELECT = { id: true, type: true, name: true, mobile: true, shopName: true } as const;
const bal = (amount: Prisma.Decimal, gold: Prisma.Decimal, silver: Prisma.Decimal): BalanceDto => ({ amount: money(amount), gold: wt(gold), silver: wt(silver) });
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

async function userName(ctx: TenantContext, id: number | null): Promise<string | null> {
  if (id == null) return null;
  return (await prisma.user.findFirst({ where: { id, businessId: ctx.businessId! }, select: { name: true } }))?.name ?? null;
}

/** Creator display names within the business (raw prisma: a creator may sit outside the active branch). */
async function userNames(ctx: TenantContext, ids: (number | null)[]): Promise<Map<number, string>> {
  const u = [...new Set(ids.filter((x): x is number => x != null))];
  if (!u.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: u }, businessId: ctx.businessId! }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ───────────── Create / edit ─────────────

/** Party / bank / bill references must exist in the caller's scope (create + edit). */
async function checkRefs(sdb: ReturnType<typeof scopedDb>, body: UdharBody) {
  const party = await sdb.party.findUnique({ where: { id: body.partyId }, select: PARTY_SELECT });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  if (body.onlineOut > 0 && !(await sdb.bankAccount.findUnique({ where: { id: body.outBankId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
  if (body.onlineIn > 0 && !(await sdb.bankAccount.findUnique({ where: { id: body.inBankId! } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
  // existence + tenant scope checked here; the ACTIVE/party/balance checks + paid update run atomically inside the tx
  if (body.settleBillId != null && !(await sdb.bill.findUnique({ where: { id: body.settleBillId }, select: { id: true } }))) {
    throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  }
  return party;
}

/** UdharTxn header columns taken from the body (create + edit). */
const txnFields = (body: UdharBody, txnDate: Date, bhavWeight: string | null) => ({
  partyId: body.partyId,
  txnDate,
  cashOut: body.cashOut,
  onlineOut: body.onlineOut,
  outBankId: body.onlineOut > 0 ? body.outBankId! : null,
  cashIn: body.cashIn,
  onlineIn: body.onlineIn,
  inBankId: body.onlineIn > 0 ? body.inBankId! : null,
  goldOut: body.goldOut,
  goldIn: body.goldIn,
  silverOut: body.silverOut,
  silverIn: body.silverIn,
  bhavDirection: body.bhav?.direction ?? null,
  bhavMetal: body.bhav?.metal ?? null,
  bhavAmount: body.bhav?.amount ?? null,
  bhavRate: body.bhav?.rate ?? null,
  bhavUnitGrams: body.bhav?.unitGrams ?? null,
  bhavWeight: bhavWeight ?? null,
  settleBillId: body.settleBillId ?? null,
  remark: body.remark ?? null,
});

/** Steps 3-5 for one txn: shop-asset ledger rows, party-balance rows, bill settlement (create, and re-post on edit). */
async function postTxn(tx: Prisma.TransactionClient, ctx: TenantContext, h: { id: number; branchId: number; txnDate: Date }, body: UdharBody, bhavWeight: string | null): Promise<void> {
  const { branchId, txnDate } = h;
  const lctx = lctxOf(ctx);
  const sid = String(h.id);

  // 3. Shop assets → LedgerEntry (source UDHAR). Bhav cut moves no shop asset.
  const lrows: ledger.LedgerEntryInput[] = [];
  const cash = (direction: 'IN' | 'OUT', amount: number, bankAccountId?: number) => {
    if (amount > 0) lrows.push({ branchId, txnDate, asset: 'MONEY', direction, amount, bankAccountId, source: 'UDHAR', sourceId: sid, partyId: body.partyId, narration: body.remark ?? null });
  };
  const metal = (asset: 'GOLD' | 'SILVER', direction: 'IN' | 'OUT', w: number) => {
    if (w > 0) lrows.push({ branchId, txnDate, asset, direction, metalForm: 'USUAL', gross: w, net: w, fine: w, source: 'UDHAR', sourceId: sid, partyId: body.partyId, narration: body.remark ?? null });
  };
  cash('OUT', body.cashOut);
  cash('OUT', body.onlineOut, body.outBankId);
  cash('IN', body.cashIn);
  cash('IN', body.onlineIn, body.inBankId);
  metal('GOLD', 'OUT', body.goldOut);
  metal('GOLD', 'IN', body.goldIn);
  metal('SILVER', 'OUT', body.silverOut);
  metal('SILVER', 'IN', body.silverIn);
  if (lrows.length) await ledger.post(tx, lctx, lrows);

  // 4. Party balance → UdharEntry (source UDHAR). + = party owes shop.
  const amount = D(body.cashOut).plus(body.onlineOut).minus(body.cashIn).minus(body.onlineIn);
  const gold = D(body.goldOut).minus(body.goldIn);
  const silver = D(body.silverOut).minus(body.silverIn);
  if (!amount.isZero() || !gold.isZero() || !silver.isZero()) {
    await udhar.post(tx, lctx, [{ branchId, partyId: body.partyId, txnDate, amount, gold, silver, source: 'UDHAR', sourceId: sid }]);
  }
  // Bhav cut row (source BHAV_CUT): moves value between money and metal on the party balance only.
  if (body.bhav && bhavWeight) {
    const w = D(bhavWeight);
    const x = D(body.bhav.amount);
    const s = body.bhav.direction === 'MONEY_TO_METAL' ? 1 : -1; // MONEY_TO_METAL: amount −X, metal +W
    await udhar.post(tx, lctx, [
      {
        branchId,
        partyId: body.partyId,
        txnDate,
        amount: x.times(-s),
        gold: body.bhav.metal === 'GOLD' ? w.times(s) : 0,
        silver: body.bhav.metal === 'SILVER' ? w.times(s) : 0,
        source: 'BHAV_CUT',
        sourceId: sid,
      },
    ]);
  }

  // 5. Settle a pending bill: SELL takes the received money, PURCHASE the money paid out, as BillPayment(s).
  // Step 3 already moved the cash and step 4 already moved the party balance — so no extra ledger/udhar rows here.
  if (body.settleBillId != null) {
    const b = await tx.bill.findUnique({ where: { id: body.settleBillId } }); // re-read inside tx: concurrency-safe checks + atomic paid
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
    if (b.partyId !== body.partyId || b.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not open for this party');
    const due = D(b.final).minus(b.paid);
    if (due.lte(0)) throw new HttpError(409, 'CONFLICT', 'Bill is already settled');
    const sell = b.kind === 'SELL';
    const [cash, online, bankId] = sell ? [body.cashIn, body.onlineIn, body.inBankId] : [body.cashOut, body.onlineOut, body.outBankId];
    const applied = D(cash).plus(online);
    if (applied.lte(0)) throw new HttpError(400, 'VALIDATION', sell ? 'Enter the amount received to settle the bill' : 'Enter the amount paid to settle the bill');
    // Paying a supplier more than the bill's due has no meaning on the bill (a sell overpay stays the customer's advance).
    if (!sell && applied.gt(due)) throw new HttpError(409, 'CONFLICT', `Paid amount exceeds the bill due (${money(due)})`);
    if (cash > 0) await tx.billPayment.create({ data: { billId: b.id, mode: 'CASH', amount: cash, txnDate, udharTxnId: h.id, createdById: ctx.userId } });
    if (online > 0) await tx.billPayment.create({ data: { billId: b.id, mode: 'ONLINE', bankAccountId: bankId!, amount: online, txnDate, udharTxnId: h.id, createdById: ctx.userId } });
    await tx.bill.update({ where: { id: b.id }, data: { paid: { increment: applied } } });
  }
}

/** Undo postTxn: reverse ledger + party rows (dated today) and deactivate the settled bill payments (delete, and edit before re-post). */
async function unpostTxn(tx: Prisma.TransactionClient, ctx: TenantContext, t: { id: number; settleBillId: number | null }): Promise<void> {
  const lctx = lctxOf(ctx);
  const sid = String(t.id);
  await ledger.reverse(tx, lctx, { source: 'UDHAR', sourceId: sid });
  await udhar.reverse(tx, lctx, { source: 'UDHAR', sourceId: sid });
  await udhar.reverse(tx, lctx, { source: 'BHAV_CUT', sourceId: sid });
  if (t.settleBillId != null) {
    const pays = await tx.billPayment.findMany({ where: { billId: t.settleBillId, udharTxnId: t.id, isActive: true } });
    if (pays.length) {
      const back = pays.reduce((a, p) => a.plus(D(p.amount)), new Prisma.Decimal(0));
      await tx.billPayment.updateMany({ where: { id: { in: pays.map((p) => p.id) } }, data: { isActive: false } });
      await tx.bill.update({ where: { id: t.settleBillId }, data: { paid: { decrement: back } } });
    }
  }
}

/** Numbered header row (UDHAR sequence of the branch) — New Udhar and a trade's inline udhar. */
async function insertTxn(tx: Prisma.TransactionClient, ctx: TenantContext, branchId: number, body: UdharBody, txnDate: Date, bhavWeight: string | null) {
  const seq = await tx.docSequence.upsert({
    where: { businessId_branchId_key: { businessId: ctx.businessId!, branchId, key: 'UDHAR' } },
    create: { businessId: ctx.businessId!, branchId, key: 'UDHAR', next: 2 },
    update: { next: { increment: 1 } },
    select: { next: true },
  });
  return tx.udharTxn.create({ data: { businessId: ctx.businessId!, branchId, txnNo: seq.next - 1, ...txnFields(body, txnDate, bhavWeight), createdById: ctx.userId } });
}

export async function createUdharTxn(ctx: TenantContext, body: UdharBody): Promise<UdharTxnDto> {
  const branchId = ctx.activeBranchId ?? ctx.scopeBranchId;
  if (branchId == null || !ctx.branchIds.includes(branchId)) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
  const party = await checkRefs(scopedDb(ctx), body);

  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const bhavWeight = body.bhav ? moneyToMetal(body.bhav.amount, body.bhav.rate, body.bhav.unitGrams) : null;

  const header = await prisma.$transaction(async (tx) => {
    const h = await insertTxn(tx, ctx, branchId, body, txnDate, bhavWeight);
    await postTxn(tx, ctx, h, body, bhavWeight);
    await logActivity(tx, ctx, { module: 'UDHAR', action: 'CREATED', entity: 'UdharTxn', entityId: String(h.id), summary: `Udhar #${h.txnNo}`, partyName: party.name });
    return h;
  });

  return getUdharTxn(ctx, header.id);
}

// ───────────── Inline udhar of a trade (TASK-99, TRD-02) ─────────────
// A buy-sell / exchange may carry an udhar jama / udhar + bhav cut. It is a real, numbered UdharTxn of the trade's
// party, branch and date, posted by the same postTxn as New Udhar (so ledger, party balance, bhav-cut rows and reports
// are identical) and reversed by the same unpostTxn. The trade owns it: edit / delete go through the trade (whose row
// is locked first), never directly (see linkedTrade). No bill settlement from a trade.

const inlineBody = (partyId: number, txnDate: Date, u: InlineUdharInput, label: string): UdharBody => ({ ...u, partyId, txnDate, remark: u.remark ?? label });
const bhavWeightOf = (u: InlineUdharInput) => (u.bhav ? moneyToMetal(u.bhav.amount, u.bhav.rate, u.bhav.unitGrams) : null);

/** Validation outside the trade's transaction (bank accounts of this business). */
export async function checkInlineUdhar(ctx: TenantContext, partyId: number, u: InlineUdharInput): Promise<void> {
  await checkRefs(scopedDb(ctx), inlineBody(partyId, new Date(), u, ''));
}

export async function postInlineUdhar(tx: Prisma.TransactionClient, ctx: TenantContext, at: { branchId: number; partyId: number; txnDate: Date }, u: InlineUdharInput, label: string): Promise<{ id: number; txnNo: number }> {
  const body = inlineBody(at.partyId, at.txnDate, u, label);
  const bhavWeight = bhavWeightOf(u);
  const h = await insertTxn(tx, ctx, at.branchId, body, at.txnDate, bhavWeight);
  await postTxn(tx, ctx, h, body, bhavWeight);
  await logActivity(tx, ctx, { module: 'UDHAR', action: 'CREATED', entity: 'UdharTxn', entityId: String(h.id), summary: `Udhar #${h.txnNo} (${label})` });
  return { id: h.id, txnNo: h.txnNo };
}

/** Edit of the owning trade: reverse and re-post under the same udhar no. */
export async function repostInlineUdhar(tx: Prisma.TransactionClient, ctx: TenantContext, id: number, at: { partyId: number; txnDate: Date }, u: InlineUdharInput, label: string): Promise<void> {
  const t = await tx.udharTxn.findUniqueOrThrow({ where: { id } });
  if (t.isDeleted) throw new HttpError(409, 'CONFLICT', 'The linked udhar entry was deleted');
  await unpostTxn(tx, ctx, t);
  const body = inlineBody(at.partyId, at.txnDate, u, label);
  const bhavWeight = bhavWeightOf(u);
  const h = await tx.udharTxn.update({ where: { id }, data: txnFields(body, at.txnDate, bhavWeight) });
  await postTxn(tx, ctx, h, body, bhavWeight);
}

/** Delete of the owning trade (or an edit that drops the inline udhar): mark deleted and reverse, once. */
export async function removeInlineUdhar(tx: Prisma.TransactionClient, ctx: TenantContext, id: number): Promise<void> {
  const flip = await tx.udharTxn.updateMany({ where: { id, isDeleted: false }, data: { isDeleted: true } });
  if (flip.count !== 1) return; // already reversed
  await unpostTxn(tx, ctx, await tx.udharTxn.findUniqueOrThrow({ where: { id } }));
}

/**
 * Bring a trade's inline udhar in line with its body, inside the trade's transaction (row already locked):
 * none → none; none → new entry; entry → re-posted under the same udhar no.; entry → removed (also on trade delete,
 * with `next` undefined). Returns the trade's inlineUdhar / bhavCut columns.
 */
export async function syncInlineUdhar(tx: Prisma.TransactionClient, ctx: TenantContext, current: unknown, next: InlineUdharInput | undefined, at: { branchId: number; partyId: number; txnDate: Date }, label: string) {
  const id = (current as { udharTxnId?: number } | null)?.udharTxnId ?? null;
  if (!next) {
    if (id != null) await removeInlineUdhar(tx, ctx, id);
    return { inlineUdhar: Prisma.DbNull, bhavCut: Prisma.DbNull };
  }
  let txnId = id;
  if (txnId != null) await repostInlineUdhar(tx, ctx, txnId, at, next, label);
  else txnId = (await postInlineUdhar(tx, ctx, at, next, label)).id;
  return {
    inlineUdhar: { udharTxnId: txnId, ...next } as Prisma.InputJsonValue,
    bhavCut: next.bhav ? ({ ...next.bhav, weight: bhavWeightOf(next) } as Prisma.InputJsonValue) : Prisma.DbNull,
  };
}

/** The trade's view of its inline udhar (`link` = the trade's inlineUdhar JSON). */
export async function inlineUdharDto(ctx: TenantContext, link: unknown): Promise<TradeUdharDto | null> {
  const id = (link as { udharTxnId?: number } | null)?.udharTxnId;
  if (id == null) return null;
  const t = await scopedDb(ctx).udharTxn.findUnique({ where: { id } });
  if (!t) return null;
  return {
    txnId: t.id, txnNo: t.txnNo,
    cashOut: money(D(t.cashOut)), onlineOut: money(D(t.onlineOut)), cashIn: money(D(t.cashIn)), onlineIn: money(D(t.onlineIn)),
    outBankId: t.outBankId, inBankId: t.inBankId,
    goldOut: wt(D(t.goldOut)), goldIn: wt(D(t.goldIn)), silverOut: wt(D(t.silverOut)), silverIn: wt(D(t.silverIn)),
    bhav: t.bhavDirection ? { direction: t.bhavDirection, metal: t.bhavMetal!, amount: money(D(t.bhavAmount)), rate: money(D(t.bhavRate)), unitGrams: Number(t.bhavUnitGrams), weight: wt(D(t.bhavWeight)) } : null,
    remark: t.remark,
  };
}

/** The trade that owns this udhar entry, if any ("buy-sell #12" / "exchange #7"). */
async function linkedTrade(ctx: TenantContext, id: number): Promise<string | null> {
  const where = { businessId: ctx.businessId!, inlineUdhar: { path: ['udharTxnId'], equals: id } };
  const bs = await prisma.buySell.findFirst({ where, select: { buySellNo: true } });
  if (bs) return `buy-sell #${bs.buySellNo}`;
  const ex = await prisma.exchange.findFirst({ where, select: { exchangeNo: true } });
  return ex ? `exchange #${ex.exchangeNo}` : null;
}
const assertNotLinked = async (ctx: TenantContext, id: number) => {
  const link = await linkedTrade(ctx, id);
  if (link) throw new HttpError(409, 'CONFLICT', `This udhar entry belongs to ${link}; edit or delete it there`);
};

/** Edit: reverse the old postings (like delete) and re-post the new body under the same txn no + branch. */
export async function updateUdharTxn(ctx: TenantContext, id: number, body: UdharBody): Promise<UdharTxnDto> {
  const sdb = scopedDb(ctx);
  const t = await sdb.udharTxn.findUnique({ where: { id } });
  if (!t || t.isDeleted) throw new HttpError(404, 'NOT_FOUND', 'Udhar transaction not found');
  await assertNotLinked(ctx, id);
  const party = await checkRefs(sdb, body);
  const txnDate = ledger.businessDate(body.txnDate ?? t.txnDate);
  const bhavWeight = body.bhav ? moneyToMetal(body.bhav.amount, body.bhav.rate, body.bhav.unitGrams) : null;

  await prisma.$transaction(async (tx) => {
    await unpostTxn(tx, ctx, t);
    const h = await tx.udharTxn.update({ where: { id }, data: txnFields(body, txnDate, bhavWeight) });
    await postTxn(tx, ctx, h, body, bhavWeight);
    await logActivity(tx, ctx, { module: 'UDHAR', action: 'EDITED', entity: 'UdharTxn', entityId: String(id), summary: `Edited udhar #${t.txnNo}`, partyName: party.name });
  });
  return getUdharTxn(ctx, id);
}

// ───────────── Read one ─────────────

export async function getUdharTxn(ctx: TenantContext, id: number): Promise<UdharTxnDto> {
  const sdb = scopedDb(ctx);
  const t = await sdb.udharTxn.findUnique({ where: { id } });
  if (!t) throw new HttpError(404, 'NOT_FOUND', 'Udhar transaction not found');

  const [party, branch] = await Promise.all([
    sdb.party.findUniqueOrThrow({ where: { id: t.partyId }, select: PARTY_SELECT }),
    sdb.branch.findUniqueOrThrow({ where: { id: t.branchId }, select: { id: true, name: true } }),
  ]);
  const bankIds = [t.outBankId, t.inBankId].filter((x): x is number => x != null);
  const banks = bankIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true, bankName: true } }) : [];
  const bName = new Map(banks.map((b) => [b.id, b.bankName]));
  const settle = t.settleBillId != null ? await sdb.bill.findUnique({ where: { id: t.settleBillId }, select: { id: true, billNo: true } }) : null;

  // Balances as of this txn (reprints stay stable after later txns): old = party rows ordered before it
  // (txnDate, then id vs this txn's first row), final = old + this txn's net rows (incl. edit/delete reversals).
  const own = { source: { in: ['UDHAR', 'BHAV_CUT'] as LedgerSource[] }, sourceId: String(t.id) };
  const first = await sdb.udharEntry.findFirst({ where: { partyId: t.partyId, ...own }, orderBy: { id: 'asc' }, select: { id: true } });
  const sameDay = first ? { txnDate: t.txnDate, id: { lt: first.id } } : { txnDate: t.txnDate };
  const [oldAgg, deltaAgg] = await Promise.all([
    sdb.udharEntry.aggregate({ where: { partyId: t.partyId, NOT: own, OR: [{ txnDate: { lt: t.txnDate } }, sameDay] }, _sum: { amount: true, gold: true, silver: true } }),
    sdb.udharEntry.aggregate({ where: { partyId: t.partyId, ...own }, _sum: { amount: true, gold: true, silver: true } }),
  ]);
  const o = { amount: D(oldAgg._sum.amount), gold: D(oldAgg._sum.gold), silver: D(oldAgg._sum.silver) };
  const d = { amount: D(deltaAgg._sum.amount), gold: D(deltaAgg._sum.gold), silver: D(deltaAgg._sum.silver) };

  return {
    id: t.id,
    txnNo: t.txnNo,
    txnDate: dateOnly(t.txnDate),
    party,
    branch,
    cashOut: money(D(t.cashOut)),
    onlineOut: money(D(t.onlineOut)),
    outBank: t.outBankId != null ? { id: t.outBankId, name: bName.get(t.outBankId) ?? '' } : null,
    cashIn: money(D(t.cashIn)),
    onlineIn: money(D(t.onlineIn)),
    inBank: t.inBankId != null ? { id: t.inBankId, name: bName.get(t.inBankId) ?? '' } : null,
    goldOut: wt(D(t.goldOut)),
    goldIn: wt(D(t.goldIn)),
    silverOut: wt(D(t.silverOut)),
    silverIn: wt(D(t.silverIn)),
    bhav: t.bhavDirection ? { direction: t.bhavDirection, metal: t.bhavMetal!, amount: money(D(t.bhavAmount)), rate: money(D(t.bhavRate)), unitGrams: Number(t.bhavUnitGrams), weight: wt(D(t.bhavWeight)) } : null,
    settleBill: settle ? { id: settle.id, billNo: settle.billNo } : null,
    old: bal(o.amount, o.gold, o.silver),
    final: bal(o.amount.plus(d.amount), o.gold.plus(d.gold), o.silver.plus(d.silver)),
    remark: t.remark,
    isDeleted: t.isDeleted,
    createdBy: await userName(ctx, t.createdById),
    createdAt: t.createdAt.toISOString(),
  };
}

// ───────────── Delete ─────────────

export async function deleteUdharTxn(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const t = await sdb.udharTxn.findUnique({ where: { id } });
  if (!t || t.isDeleted) throw new HttpError(404, 'NOT_FOUND', 'Udhar transaction not found');
  await assertNotLinked(ctx, id);
  await prisma.$transaction(async (tx) => {
    await tx.udharTxn.update({ where: { id }, data: { isDeleted: true } });
    await unpostTxn(tx, ctx, t);
    await logActivity(tx, ctx, { module: 'UDHAR', action: 'DELETED', entity: 'UdharTxn', entityId: String(id), summary: `Deleted udhar #${t.txnNo}` });
  });
}

// ───────────── Lists ─────────────

/** Udhar List: one row per UdharEntry across sources. */
export async function listEntries(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; partyId?: number; source?: string; from?: Date; to?: Date }): Promise<Paged<UdharEntryRowDto>> {
  const sdb = scopedDb(ctx);
  // keyword: party name/mobile, narration or the raw source id.
  // shortcut: bill numbers are resolved after paging (referenceLabels), so they aren't searchable here; add a join if users ask.
  const kwParties = q.q ? (await sdb.party.findMany({ where: { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { mobile: { contains: q.q } }] }, select: { id: true } })).map((p) => p.id) : [];
  const where: any = {
    ...(q.partyId ? { partyId: q.partyId } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.from || q.to ? { txnDate: { ...(q.from ? { gte: ledger.businessDate(q.from) } : {}), ...(q.to ? { lte: ledger.businessDate(q.to) } : {}) } } : {}),
    ...(q.q ? { OR: [{ partyId: { in: kwParties } }, { narration: { contains: q.q, mode: 'insensitive' } }, { sourceId: q.q }] } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.udharEntry.findMany({ where, orderBy: [{ txnDate: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    sdb.udharEntry.count({ where }),
  ]);

  const partyMap = await partyRefs(sdb, rows.map((r) => r.partyId));
  const reference = await referenceLabels(sdb, rows);
  const bhav = await bhavNotes(sdb, rows);
  const running = await runningBalances(ctx, rows);
  const items: UdharEntryRowDto[] = rows.map((r) => ({
    source: r.source,
    sourceId: r.sourceId,
    reference: reference.get(`${r.source}:${r.sourceId}`) ?? r.sourceId,
    txnDate: dateOnly(r.txnDate),
    party: partyMap.get(r.partyId)!,
    amount: money(D(r.amount)),
    gold: wt(D(r.gold)),
    silver: wt(D(r.silver)),
    narration: r.narration ?? bhav.get(`${r.source}:${r.sourceId}`) ?? null,
    isReversal: r.reversalOfId != null,
    createdAt: r.createdAt.toISOString(),
    ...running.get(String(r.id)),
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Udhar List Old/Final: per-party running sum in the Statement's order (txnDate, id) over all scoped rows,
 *  read back only for the page's rows. final = running sum incl. the row, old = final − row. */
async function runningBalances(ctx: TenantContext, rows: { id: bigint; partyId: number }[]): Promise<Map<string, { old: BalanceDto; final: BalanceDto }>> {
  if (rows.length === 0 || ctx.branchIds.length === 0) return new Map();
  const partyIds = [...new Set(rows.map((r) => r.partyId))];
  const ids = rows.map((r) => r.id);
  const res = await prisma.$queryRaw<Array<{ id: string; amount: unknown; gold: unknown; silver: unknown; run_amount: unknown; run_gold: unknown; run_silver: unknown }>>(Prisma.sql`
    SELECT id::text AS id, amount, gold, silver, run_amount, run_gold, run_silver FROM (
      SELECT id, amount, gold, silver,
        SUM(amount) OVER w AS run_amount, SUM(gold) OVER w AS run_gold, SUM(silver) OVER w AS run_silver
      FROM "UdharEntry"
      WHERE "businessId" = ${ctx.businessId!} AND "branchId" IN (${Prisma.join(ctx.branchIds)}) AND "partyId" IN (${Prisma.join(partyIds)})
      WINDOW w AS (PARTITION BY "partyId" ORDER BY "txnDate", id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    ) t WHERE id IN (${Prisma.join(ids)})`);
  return new Map(
    res.map((r) => {
      const fa = D(r.run_amount), fg = D(r.run_gold), fs = D(r.run_silver);
      return [r.id, { old: bal(fa.minus(D(r.amount)), fg.minus(D(r.gold)), fs.minus(D(r.silver))), final: bal(fa, fg, fs) }];
    }),
  );
}

/** Udhar Ledger: party-wise balances (SQL groupBy). */
export async function listLedger(ctx: TenantContext, q: { page: number; pageSize: number; type?: PartyType; nonZero: 'true' | 'false'; q?: string; from?: Date; to?: Date }): Promise<Paged<PartyBalanceRowDto>> {
  const sdb = scopedDb(ctx);
  const grouped = await sdb.udharEntry.groupBy({ by: ['partyId'], _sum: { amount: true, gold: true, silver: true }, _max: { txnDate: true } });
  // shortcut: party-name/type filter + pagination done in app over the grouped parties (hundreds per shop); move to a raw joined query if a shop's party count grows into the thousands.
  const partyIds = grouped.map((g) => g.partyId);
  if (partyIds.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
  const parties = await sdb.party.findMany({
    where: { id: { in: partyIds }, ...(q.type ? { type: q.type } : {}), ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { mobile: { contains: q.q } }] } : {}) },
    select: PARTY_SELECT,
  });
  const pMap = new Map(parties.map((p) => [p.id, p]));
  const rows = grouped
    .filter((g) => pMap.has(g.partyId))
    .map((g) => {
      const amount = D(g._sum.amount);
      const gold = D(g._sum.gold);
      const silver = D(g._sum.silver);
      return { party: pMap.get(g.partyId)!, amount, gold, silver, lastTxnDate: g._max.txnDate };
    })
    .filter((r) => q.nonZero !== 'true' || !r.amount.isZero() || !r.gold.isZero() || !r.silver.isZero());
  rows.sort((a, b) => (b.lastTxnDate?.getTime() ?? 0) - (a.lastTxnDate?.getTime() ?? 0));
  const total = rows.length;
  const page = rows.slice((q.page - 1) * q.pageSize, (q.page - 1) * q.pageSize + q.pageSize);
  const from = q.from ? ledger.businessDate(q.from) : null;
  const to = q.to ? ledger.businessDate(q.to) : null;
  const period = await periodBreakdown(ctx, page.map((r) => r.party.id), from, to);
  const items: PartyBalanceRowDto[] = page.map((r) => ({ party: r.party, ...bal(r.amount, r.gold, r.silver), lastTxnDate: r.lastTxnDate ? dateOnly(r.lastTxnDate) : null, ...period.get(r.party.id) }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** TASK-83: per-party Old/In/Out/Final per unit over [from,to] — scoped raw SQL, only the page's parties.
 *  old = Σ before `from` (0 when no `from`); in = Σ positive, out = Σ |negative| in range; final = old + in − out. */
async function periodBreakdown(ctx: TenantContext, partyIds: number[], from: Date | null, to: Date | null): Promise<Map<number, { old: BalanceDto; in: BalanceDto; out: BalanceDto; final: BalanceDto }>> {
  if (partyIds.length === 0) return new Map();
  const before = from ? Prisma.sql`"txnDate" < ${from}` : Prisma.sql`FALSE`;
  const inRange = Prisma.sql`(${from ? Prisma.sql`"txnDate" >= ${from}` : Prisma.sql`TRUE`}) AND (${to ? Prisma.sql`"txnDate" <= ${to}` : Prisma.sql`TRUE`})`;
  const rows = await prisma.$queryRaw<Array<Record<'partyId' | `${'old' | 'in' | 'out'}_${'amount' | 'gold' | 'silver'}`, number | string>>>(Prisma.sql`
    SELECT "partyId",
      COALESCE(SUM(CASE WHEN ${before} THEN amount ELSE 0 END), 0) AS old_amount,
      COALESCE(SUM(CASE WHEN ${before} THEN gold ELSE 0 END), 0) AS old_gold,
      COALESCE(SUM(CASE WHEN ${before} THEN silver ELSE 0 END), 0) AS old_silver,
      COALESCE(SUM(CASE WHEN ${inRange} AND amount > 0 THEN amount ELSE 0 END), 0) AS in_amount,
      COALESCE(SUM(CASE WHEN ${inRange} AND gold > 0 THEN gold ELSE 0 END), 0) AS in_gold,
      COALESCE(SUM(CASE WHEN ${inRange} AND silver > 0 THEN silver ELSE 0 END), 0) AS in_silver,
      COALESCE(SUM(CASE WHEN ${inRange} AND amount < 0 THEN -amount ELSE 0 END), 0) AS out_amount,
      COALESCE(SUM(CASE WHEN ${inRange} AND gold < 0 THEN -gold ELSE 0 END), 0) AS out_gold,
      COALESCE(SUM(CASE WHEN ${inRange} AND silver < 0 THEN -silver ELSE 0 END), 0) AS out_silver
    FROM "UdharEntry"
    WHERE "businessId" = ${ctx.businessId!} AND "branchId" IN (${Prisma.join(ctx.branchIds)}) AND "partyId" IN (${Prisma.join(partyIds)})
    GROUP BY "partyId"`);
  return new Map(
    rows.map((r) => [
      Number(r.partyId),
      {
        old: bal(D(r.old_amount), D(r.old_gold), D(r.old_silver)),
        in: bal(D(r.in_amount), D(r.in_gold), D(r.in_silver)),
        out: bal(D(r.out_amount), D(r.out_gold), D(r.out_silver)),
        final: bal(D(r.old_amount).plus(D(r.in_amount)).minus(D(r.out_amount)), D(r.old_gold).plus(D(r.in_gold)).minus(D(r.out_gold)), D(r.old_silver).plus(D(r.in_silver)).minus(D(r.out_silver))),
      },
    ]),
  );
}

export async function partyBalance(ctx: TenantContext, partyId: number): Promise<BalanceDto> {
  const sdb = scopedDb(ctx);
  if (!(await sdb.party.findUnique({ where: { id: partyId }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const agg = await sdb.udharEntry.aggregate({ where: { partyId }, _sum: { amount: true, gold: true, silver: true } });
  return bal(D(agg._sum.amount), D(agg._sum.gold), D(agg._sum.silver));
}

export async function statement(ctx: TenantContext, partyId: number, q: { from?: Date; to?: Date }): Promise<StatementDto> {
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: partyId }, select: PARTY_SELECT });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const from = q.from ? ledger.businessDate(q.from) : null;
  const to = q.to ? ledger.businessDate(q.to) : null;

  const openAgg = from ? await sdb.udharEntry.aggregate({ where: { partyId, txnDate: { lt: from } }, _sum: { amount: true, gold: true, silver: true } }) : null;
  let runAmount = D(openAgg?._sum.amount);
  let runGold = D(openAgg?._sum.gold);
  let runSilver = D(openAgg?._sum.silver);
  const opening = bal(runAmount, runGold, runSilver);

  const rows = await sdb.udharEntry.findMany({
    where: { partyId, ...(from || to ? { txnDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}) },
    orderBy: [{ txnDate: 'asc' }, { id: 'asc' }],
  });
  const reference = await referenceLabels(sdb, rows);
  const bhav = await bhavNotes(sdb, rows);
  const statementRows = rows.map((r) => {
    runAmount = runAmount.plus(D(r.amount));
    runGold = runGold.plus(D(r.gold));
    runSilver = runSilver.plus(D(r.silver));
    return {
      source: r.source,
      sourceId: r.sourceId,
      reference: reference.get(`${r.source}:${r.sourceId}`) ?? r.sourceId,
      txnDate: dateOnly(r.txnDate),
      party,
      amount: money(D(r.amount)),
      gold: wt(D(r.gold)),
      silver: wt(D(r.silver)),
      narration: r.narration ?? bhav.get(`${r.source}:${r.sourceId}`) ?? null,
      isReversal: r.reversalOfId != null,
      createdAt: r.createdAt.toISOString(),
      balance: bal(runAmount, runGold, runSilver),
    };
  });
  return { party, opening, rows: statementRows, closing: bal(runAmount, runGold, runSilver) };
}

/** TASK-83: compact line summary for the pending-bills list, e.g. "2× Ring, 1× Chain" (pcs per description, top 4). */
function summarizeItems(items: { description: string; pcs: number }[]): string {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.description, (counts.get(it.description) ?? 0) + (it.pcs || 1));
  const parts = [...counts.entries()].map(([name, n]) => `${n}× ${name}`);
  return parts.slice(0, 4).join(', ') + (parts.length > 4 ? `, +${parts.length - 4} more` : '');
}

/** Pending bills (balance ≠ 0), both kinds. Reads Bill (empty until billing lands). */
export async function pendingBills(
  ctx: TenantContext,
  q: { page: number; pageSize: number; q?: string; partyId?: number; type?: PartyType; kind?: 'SELL' | 'PURCHASE'; from?: Date; to?: Date },
): Promise<Paged<BillListItemDto> & { summary: PendingBillsSummaryDto }> {
  const sdb = scopedDb(ctx);
  const noSummary: PendingBillsSummaryDto = { count: 0, saleDue: '0.00', purchaseDue: '0.00' };
  if (ctx.branchIds.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize, summary: noSummary };
  // Pending = ACTIVE bill with final ≠ paid (a column-vs-column comparison Prisma can't express through the scoped client),
  // so resolve the matching ids with a scoped raw query (type filters on the party via a join), then page them normally.
  const conds: Prisma.Sql[] = [
    Prisma.sql`b."businessId" = ${ctx.businessId!}`,
    Prisma.sql`b."branchId" IN (${Prisma.join(ctx.branchIds)})`,
    Prisma.sql`b.status::text = 'ACTIVE'`,
    Prisma.sql`b.final <> b.paid`,
  ];
  if (q.partyId) conds.push(Prisma.sql`b."partyId" = ${q.partyId}`);
  if (q.type) conds.push(Prisma.sql`p.type::text = ${q.type}`);
  if (q.kind) conds.push(Prisma.sql`b.kind::text = ${q.kind}`);
  // bill date range, same business-day rule as the bill list (billing listBills)
  if (q.from) conds.push(Prisma.sql`b."billDate" >= ${dateOnly(ledger.businessDate(q.from))}::date`);
  if (q.to) conds.push(Prisma.sql`b."billDate" <= ${dateOnly(ledger.businessDate(q.to))}::date`);
  if (q.q) {
    const kw = `%${q.q}%`;
    conds.push(Prisma.sql`(b."billNo" ILIKE ${kw} OR p.name ILIKE ${kw} OR p.mobile ILIKE ${kw})`);
  }
  const join = q.type || q.q ? Prisma.sql`JOIN "Party" p ON p.id = b."partyId"` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ id: number; kind: string; due: string }[]>(
    Prisma.sql`SELECT b.id, b.kind::text AS kind, (b.final - b.paid)::text AS due FROM "Bill" b ${join} WHERE ${Prisma.join(conds, ' AND ')}`,
  );
  const ids = rows.map((r) => r.id);
  // UDH-07 cards over the same rows the list pages (so the filters always match), in rupees (BILL-15 R4); due = final − paid
  const dueOf = (kind: string) => money(rows.filter((r) => r.kind === kind).reduce((a, r) => a.plus(r.due), D(0)));
  const summary: PendingBillsSummaryDto = { count: rows.length, saleDue: dueOf('SELL'), purchaseDue: dueOf('PURCHASE') };
  if (ids.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize, summary };

  const bills = await sdb.bill.findMany({
    where: { id: { in: ids } },
    include: { _count: { select: { items: true } }, items: { select: { description: true, pcs: true } } },
    orderBy: [{ billDate: 'desc' }, { id: 'desc' }],
    skip: (q.page - 1) * q.pageSize,
    take: q.pageSize,
  });
  const partyMap = await partyRefs(sdb, bills.map((b) => b.partyId));
  const branchMap = await branchNames(sdb, bills.map((b) => b.branchId));
  const creatorMap = await userNames(ctx, bills.map((b) => b.createdById));
  const items: BillListItemDto[] = bills.map((b) => ({
    id: b.id,
    kind: b.kind,
    billType: b.billType,
    billNo: b.billNo,
    billDate: dateOnly(b.billDate),
    party: partyMap.get(b.partyId)!,
    branch: { id: b.branchId, name: branchMap.get(b.branchId) ?? '' },
    itemCount: b._count.items,
    itemsSummary: summarizeItems(b.items),
    final: money(D(b.final)),
    paid: money(D(b.paid)),
    balance: money(D(b.final).minus(b.paid)),
    keepBalanceAs: b.keepBalanceAs,
    keepWeight: b.keepWeight != null ? wt(D(b.keepWeight)) : null,
    status: b.status,
    createdBy: b.createdById != null ? (creatorMap.get(b.createdById) ?? null) : null,
    createdAt: b.createdAt.toISOString(),
  }));
  return { items, total: ids.length, page: q.page, pageSize: q.pageSize, summary };
}

// ───────────── helpers ─────────────

async function partyRefs(sdb: any, ids: number[]): Promise<Map<number, PartyRefDto>> {
  const u = [...new Set(ids)];
  if (!u.length) return new Map();
  const rows = await sdb.party.findMany({ where: { id: { in: u } }, select: PARTY_SELECT });
  return new Map(rows.map((p: PartyRefDto) => [p.id, p]));
}

async function branchNames(sdb: any, ids: number[]): Promise<Map<number, string>> {
  const u = [...new Set(ids)];
  if (!u.length) return new Map();
  const rows = await sdb.branch.findMany({ where: { id: { in: u } }, select: { id: true, name: true } });
  return new Map(rows.map((b: { id: number; name: string }) => [b.id, b.name]));
}

/** BHAV_CUT rows are posted without narration: describe the conversion from its udhar txn, keyed `BHAV_CUT:<id>`.
 *  shortcut: reads the txn's current bhav, so a row reversed by an edit shows the edited cut; store narration at post time if that matters. */
async function bhavNotes(sdb: any, rows: { source: string; sourceId: string }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.filter((r) => r.source === 'BHAV_CUT').map((r) => Number(r.sourceId)).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const txns: { id: number; bhavMetal: string | null; bhavAmount: unknown; bhavRate: unknown; bhavUnitGrams: number | null; bhavWeight: unknown }[] = await sdb.udharTxn.findMany({
    where: { id: { in: ids } },
    select: { id: true, bhavMetal: true, bhavAmount: true, bhavRate: true, bhavUnitGrams: true, bhavWeight: true },
  });
  const unit = (g: number | null) => (g === 1000 ? '1 kg' : `${g} g`);
  return new Map(txns.filter((t) => t.bhavMetal).map((t) => [`BHAV_CUT:${t.id}`, `Bhav ${t.bhavMetal} ₹${money(D(t.bhavAmount))} @ ₹${money(D(t.bhavRate))}/${unit(t.bhavUnitGrams)} = ${wt(D(t.bhavWeight))} g`]));
}

/** Display reference per (source, sourceId): UdharTxn no for UDHAR/BHAV_CUT, bill no for bill sources. */
async function referenceLabels(sdb: any, rows: { source: string; sourceId: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const udharIds = new Set<number>();
  const billIds = new Set<number>();
  for (const r of rows) {
    const n = Number(r.sourceId);
    if (!Number.isInteger(n)) continue;
    if (r.source === 'UDHAR' || r.source === 'BHAV_CUT') udharIds.add(n);
    else billIds.add(n);
  }
  if (udharIds.size) {
    const txns = await sdb.udharTxn.findMany({ where: { id: { in: [...udharIds] } }, select: { id: true, txnNo: true } });
    for (const t of txns) {
      out.set(`UDHAR:${t.id}`, `UDHAR-${t.txnNo}`);
      out.set(`BHAV_CUT:${t.id}`, `UDHAR-${t.txnNo}`);
    }
  }
  if (billIds.size) {
    const bills = await sdb.bill.findMany({ where: { id: { in: [...billIds] } }, select: { id: true, billNo: true, kind: true } });
    for (const b of bills) out.set(`${b.kind === 'SELL' ? 'SELL_BILL' : 'PURCHASE_BILL'}:${b.id}`, b.billNo);
  }
  return out;
}
