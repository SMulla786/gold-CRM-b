import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { assertKachaAvailable } from '../../../lib/kacha';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { exchangeBody, exchangeListQuery, fineWeight, metalToMoney } from '../../../shared';
import type { ExchangeDto, Paged, TradeHistoryDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, dateRange, docHistory, lctxOf, loadPayments, loadRefs, metalRow, money, nextNo, payPlan, payRows, savePayments, settingsUnit, snap, wt } from './common';

type ExchangeBody = z.infer<typeof exchangeBody>;

/** Validate a body and work out its figures (shared by create and edit). */
async function prepare(ctx: TenantContext, body: ExchangeBody) {
  const party = await scopedDb(ctx).party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const plan = await payPlan(ctx, body);
  const unit = await settingsUnit(ctx, body.metal);

  const lines = body.lines.map((l) => ({ ...l, fine: D(fineWeight(l.weight, l.touch)) }));
  const totalFine = lines.reduce((a, l) => a.plus(l.fine), D(0));
  const totalWeight = lines.reduce((a, l) => a.plus(l.weight), D(0));
  const afterFine = totalFine.plus(body.diffFine);
  if (afterFine.lte(0)) throw new HttpError(400, 'VALIDATION', 'After-difference fine must be positive');
  const finalAmount = body.rate > 0 ? D(metalToMoney(afterFine, body.rate, unit)).plus(body.charges).minus(body.discount) : D(0);
  return { party, plan, lines, totalFine, totalWeight, afterFine, finalAmount };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

const docData = (body: ExchangeBody, p: Prepared) => ({
  side: body.side, partyId: body.partyId, metal: body.metal,
  totalFine: p.totalFine, diffFine: body.diffFine, afterFine: p.afterFine, rate: body.rate, charges: body.charges, discount: body.discount, finalAmount: p.finalAmount,
  cash: p.plan.cash, online: p.plan.online, bankAccountId: p.plan.bankAccountId, remark: body.remark ?? null,
  lines: { create: p.lines.map((l) => ({ weight: l.weight, touch: l.touch, fine: l.fine, serialNo: l.serialNo ?? null })) },
});

/** Ledger + udhar postings of an exchange (create and the re-post half of an edit). */
async function post(tx: Prisma.TransactionClient, ctx: TenantContext, doc: { id: number; exchangeNo: number; branchId: number; txnDate: Date }, body: ExchangeBody, p: Prepared) {
  const lctx = lctxOf(ctx);
  const sid = String(doc.id);
  const sellOut = body.side === 'SELL';
  const rows = [metalRow('EXCHANGE', doc.branchId, doc.txnDate, sellOut ? 'OUT' : 'IN', body.metal, 'KACHA', p.totalWeight, p.afterFine, sid, body.partyId, `Exchange #${doc.exchangeNo}`)];
  rows.push(...payRows(p.plan, 'EXCHANGE', doc.branchId, doc.txnDate, sellOut ? 'IN' : 'OUT', sid, body.partyId, `Exchange #${doc.exchangeNo}`));
  await ledger.post(tx, lctx, rows);

  if (body.rate > 0) {
    const remaining = p.finalAmount.minus(p.plan.cash).minus(p.plan.online); // >0 = unsettled money value of the trade
    if (!remaining.isZero()) await udhar.post(tx, lctx, [{ branchId: doc.branchId, partyId: body.partyId, txnDate: doc.txnDate, amount: sellOut ? remaining : remaining.negated(), source: 'EXCHANGE', sourceId: sid, narration: `Exchange #${doc.exchangeNo}` }]);
  } else {
    const m = sellOut ? p.afterFine : p.afterFine.negated(); // BUY: shop owes the metal (party credit); SELL: party owes it
    await udhar.post(tx, lctx, [{ branchId: doc.branchId, partyId: body.partyId, txnDate: doc.txnDate, gold: body.metal === 'GOLD' ? m : 0, silver: body.metal === 'SILVER' ? m : 0, source: 'EXCHANGE', sourceId: sid, narration: `Exchange #${doc.exchangeNo}` }]);
  }
}

export async function createExchange(ctx: TenantContext, body: ExchangeBody): Promise<ExchangeDto> {
  const branchId = activeBranch(ctx);
  const p = await prepare(ctx, body);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());

  const id = await prisma.$transaction(async (tx) => {
    const exchangeNo = await nextNo(tx, ctx.businessId!, branchId, 'EXCHANGE');
    const ex = await tx.exchange.create({ data: { businessId: ctx.businessId!, branchId, exchangeNo, txnDate, createdById: ctx.userId, ...docData(body, p) } });
    if (body.side === 'SELL') await assertKachaAvailable(tx, branchId, body.metal, p.afterFine); // can't sell more kacha than the pool holds
    if (p.plan.rows) await savePayments(tx, ctx, 'EXCHANGE', ex.id, p.plan);
    await post(tx, ctx, { id: ex.id, exchangeNo, branchId, txnDate }, body, p);
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'CREATED', entity: 'EXCHANGE', entityId: String(ex.id), summary: `Exchange #${exchangeNo} ${body.side} ${wt(p.afterFine)}g`, partyName: p.party.name });
    return ex.id;
  });
  return getExchange(ctx, id);
}

/**
 * Edit = reverse the old postings exactly as delete does, then post the new body, in ONE tx; same id + exchange no.
 * Rejected (409) once the exchange was processed into kacha (revert the processing first, as for delete).
 * The kacha pool of every touched metal must stay ≥ 0 afterwards (same guard create SELL / delete BUY apply).
 */
export async function updateExchange(ctx: TenantContext, id: number, body: ExchangeBody): Promise<ExchangeDto> {
  const sdb = scopedDb(ctx);
  const old = await sdb.exchange.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  if (!old) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  if ((await sdb.kachaProcess.count({ where: { exchangeId: id, reverted: false } })) > 0) throw new HttpError(409, 'CONFLICT', 'This exchange was sent to melt / refine; revert that processing before editing');
  const p = await prepare(ctx, body);
  const txnDate = ledger.businessDate(body.txnDate ?? old.txnDate);
  const lctx = lctxOf(ctx);
  const before = snap({ ...old, payments: await loadPayments(ctx, 'EXCHANGE', id) });

  await prisma.$transaction(async (tx) => {
    await ledger.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await tx.exchangeLine.deleteMany({ where: { exchangeId: id } });
    const after = await tx.exchange.update({ where: { id }, data: { txnDate, ...docData(body, p) }, include: { lines: { orderBy: { id: 'asc' } } } });
    await savePayments(tx, ctx, 'EXCHANGE', id, p.plan);
    await post(tx, ctx, { id, exchangeNo: old.exchangeNo, branchId: old.branchId, txnDate }, body, p);
    for (const m of new Set([old.metal, body.metal])) await assertKachaAvailable(tx, old.branchId, m, 0);
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'EDITED', entity: 'EXCHANGE', entityId: String(id), summary: `Edited exchange #${old.exchangeNo}`, partyName: p.party.name, meta: { before, after: snap({ ...after, payments: p.plan.rows ?? [] }) } });
  });
  return getExchange(ctx, id);
}

export async function deleteExchange(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const ex = await sdb.exchange.findFirst({ where: { id } });
  if (!ex) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  const linked = await sdb.kachaProcess.count({ where: { exchangeId: id, reverted: false } });
  if (linked > 0) throw new HttpError(409, 'CONFLICT', 'Revert the linked kacha processing first');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    // A BUY added kacha to the pool; reversing removes it — 409 if that metal has since been melted away.
    if (ex.side === 'BUY') await assertKachaAvailable(tx, ex.branchId, ex.metal, ex.afterFine);
    await ledger.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await tx.exchange.delete({ where: { id } }); // cascades lines
    await savePayments(tx, ctx, 'EXCHANGE', id, null);
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'DELETED', entity: 'EXCHANGE', entityId: String(id), summary: `Deleted exchange #${ex.exchangeNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toDto(ctx: TenantContext, ex: any): Promise<ExchangeDto> {
  const [refs, payments, procs] = await Promise.all([loadRefs(ctx, ex), loadPayments(ctx, 'EXCHANGE', ex.id), scopedDb(ctx).kachaProcess.count({ where: { exchangeId: ex.id, reverted: false } })]);
  const bal = D(ex.finalAmount).minus(ex.cash).minus(ex.online);
  return {
    id: ex.id, exchangeNo: ex.exchangeNo, side: ex.side, party: refs.party, branch: refs.branch, metal: ex.metal, txnDate: dateOnly(ex.txnDate),
    totalFine: wt(ex.totalFine), diffFine: wt(ex.diffFine), afterFine: wt(ex.afterFine), rate: money(ex.rate), charges: money(ex.charges), discount: money(ex.discount),
    finalAmount: money(ex.finalAmount), cash: money(ex.cash), online: money(ex.online), bankAccount: refs.bankAccount,
    balance: money(ex.side === 'BUY' ? bal.negated() : bal), remark: ex.remark,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lines: ex.lines.map((l: any) => ({ id: l.id, weight: wt(l.weight), touch: String(l.touch), fine: wt(l.fine), serialNo: l.serialNo })),
    processed: procs > 0, createdBy: refs.createdBy, createdAt: ex.createdAt.toISOString(), payments,
  };
}

export async function getExchange(ctx: TenantContext, id: number): Promise<ExchangeDto> {
  const ex = await scopedDb(ctx).exchange.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  if (!ex) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  return toDto(ctx, ex);
}

export async function exchangeHistory(ctx: TenantContext, id: number): Promise<TradeHistoryDto[]> {
  if (!(await scopedDb(ctx).exchange.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  return docHistory(ctx, 'EXCHANGE', id);
}

export async function listExchange(ctx: TenantContext, query: z.infer<typeof exchangeListQuery>): Promise<Paged<ExchangeDto>> {
  const sdb = scopedDb(ctx);
  const and: Prisma.ExchangeWhereInput[] = [{ ...(query.side ? { side: query.side } : {}), ...(query.metal ? { metal: query.metal } : {}), ...(query.partyId ? { partyId: query.partyId } : {}), ...dateRange(query) }];
  if (query.q) {
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    const asNo = Number(query.q);
    and.push({ OR: [...(Number.isInteger(asNo) && asNo > 0 && asNo <= 2_147_483_647 ? [{ exchangeNo: asNo }] : []), { partyId: { in: parties.map((p) => p.id) } }] });
  }
  if (query.partyType) and.push({ partyId: { in: (await sdb.party.findMany({ where: { type: query.partyType }, select: { id: true } })).map((p) => p.id) } });
  if (query.processed) {
    // "processed" = has an active (non-reverted) kacha process, same as the DTO flag.
    const ids = (await sdb.kachaProcess.findMany({ where: { exchangeId: { not: null }, reverted: false }, select: { exchangeId: true }, distinct: ['exchangeId'] })).map((k) => k.exchangeId!);
    and.push(query.processed === 'true' ? { id: { in: ids } } : { id: { notIn: ids } });
  }
  const where = { AND: and };
  const [rows, total] = await Promise.all([
    sdb.exchange.findMany({ where, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.exchange.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}
