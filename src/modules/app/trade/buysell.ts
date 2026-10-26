import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { buySellBody, buySellListQuery, metalToMoney } from '../../../shared';
import type { BuySellDto, Paged, TradeHistoryDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, dateRange, docHistory, lctxOf, loadPayments, loadRefs, metalRow, money, nextNo, payPlan, payRows, savePayments, settingsUnit, snap, wt } from './common';

type BuySellBody = z.infer<typeof buySellBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Validate a body and work out its figures (shared by create and edit). */
async function prepare(ctx: TenantContext, body: BuySellBody) {
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const plan = await payPlan(ctx, body);
  const unit = await settingsUnit(ctx, body.metal);

  const lines = body.lines.map((l) => ({ ...l, amount: D(metalToMoney(l.weight, l.rate, unit)) }));
  const totalWeight = lines.reduce((a, l) => a.plus(l.weight), D(0));
  const totalAmount = lines.reduce((a, l) => a.plus(l.amount), D(0)).minus(body.discount);

  // A linked booking must match the trade and be priced at the locked rate.
  const booking = body.bhavBookingId != null ? await sdb.bhavBooking.findFirst({ where: { id: body.bhavBookingId } }) : null;
  if (body.bhavBookingId != null) {
    if (!booking) throw new HttpError(404, 'NOT_FOUND', 'Booking not found');
    if (booking.partyId !== body.partyId || booking.metal !== body.metal || booking.side !== body.side) throw new HttpError(400, 'VALIDATION', 'Booking does not match this trade');
    if (!lines.every((l) => D(l.rate).equals(booking.rate))) throw new HttpError(400, 'VALIDATION', 'Every line must be at the booking rate');
  }
  return { party, plan, lines, totalWeight, totalAmount };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

/** Take the delivered weight off a linked booking (atomic; must still be open and have enough pending). */
async function takeFromBooking(tx: Prisma.TransactionClient, bookingId: number, totalWeight: Prisma.Decimal) {
  const dec = await tx.bhavBooking.updateMany({ where: { id: bookingId, status: { in: ['PENDING', 'PARTIAL'] }, pendingWeight: { gte: totalWeight } }, data: { pendingWeight: { decrement: totalWeight } } });
  if (dec.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking is not open or lacks the pending weight');
  const fresh = await tx.bhavBooking.findUniqueOrThrow({ where: { id: bookingId } });
  await tx.bhavBooking.update({ where: { id: bookingId }, data: { status: D(fresh.pendingWeight).isZero() ? 'DELIVERED' : 'PARTIAL' } });
}

/** Ledger + udhar postings of a trade (create and the re-post half of an edit). */
async function post(tx: Prisma.TransactionClient, ctx: TenantContext, doc: { id: number; buySellNo: number; branchId: number; txnDate: Date }, body: BuySellBody, p: Prepared) {
  const lctx = lctxOf(ctx);
  const buyIn = body.side === 'BUY'; // shop buys bullion in, pays out
  const sid = String(doc.id);
  const rows = [metalRow('BUY_SELL', doc.branchId, doc.txnDate, buyIn ? 'IN' : 'OUT', body.metal, 'BULLION', p.totalWeight, p.totalWeight, sid, body.partyId, `Buy-sell #${doc.buySellNo}`)];
  rows.push(...payRows(p.plan, 'BUY_SELL', doc.branchId, doc.txnDate, buyIn ? 'OUT' : 'IN', sid, body.partyId, `Buy-sell #${doc.buySellNo}`));
  await ledger.post(tx, lctx, rows);
  const remaining = p.totalAmount.minus(p.plan.cash).minus(p.plan.online);
  if (!remaining.isZero()) await udhar.post(tx, lctx, [{ branchId: doc.branchId, partyId: body.partyId, txnDate: doc.txnDate, amount: buyIn ? remaining.negated() : remaining, source: 'BUY_SELL', sourceId: sid, narration: `Buy-sell #${doc.buySellNo}` }]);
}

/** Reverse a trade's postings and give its weight back to the linked booking (delete and the undo half of an edit). */
async function unpost(tx: Prisma.TransactionClient, ctx: TenantContext, bs: { id: number; bhavBookingId: number | null; totalWeight: Prisma.Decimal }) {
  const lctx = lctxOf(ctx);
  await ledger.reverse(tx, lctx, { source: 'BUY_SELL', sourceId: String(bs.id) });
  await udhar.reverse(tx, lctx, { source: 'BUY_SELL', sourceId: String(bs.id) });
  if (bs.bhavBookingId != null) {
    // Atomic increment (not read-then-write) so concurrent deletes on the same booking don't lose a restore.
    const rec = await tx.bhavBooking.updateMany({ where: { id: bs.bhavBookingId, status: { not: 'CANCELLED' } }, data: { pendingWeight: { increment: bs.totalWeight } } });
    if (rec.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking was cancelled; cannot restore pending weight');
    const fresh = await tx.bhavBooking.findUniqueOrThrow({ where: { id: bs.bhavBookingId } });
    await tx.bhavBooking.update({ where: { id: bs.bhavBookingId }, data: { status: D(fresh.pendingWeight).equals(fresh.weight) ? 'PENDING' : 'PARTIAL' } });
  }
}

export async function createBuySell(ctx: TenantContext, body: BuySellBody): Promise<BuySellDto> {
  const branchId = activeBranch(ctx);
  const p = await prepare(ctx, body);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());

  const id = await prisma.$transaction(async (tx) => {
    if (body.bhavBookingId != null) await takeFromBooking(tx, body.bhavBookingId, p.totalWeight);
    const buySellNo = await nextNo(tx, ctx.businessId!, branchId, 'BUY_SELL');
    const bs = await tx.buySell.create({
      data: {
        businessId: ctx.businessId!, branchId, buySellNo, side: body.side, partyId: body.partyId, metal: body.metal, txnDate, totalWeight: p.totalWeight, discount: body.discount, totalAmount: p.totalAmount,
        cash: p.plan.cash, online: p.plan.online, bankAccountId: p.plan.bankAccountId, bhavBookingId: body.bhavBookingId ?? null, narration: body.narration ?? null, createdById: ctx.userId,
        lines: { create: p.lines.map((l) => ({ weight: l.weight, rate: l.rate, amount: l.amount })) },
      },
    });
    if (p.plan.rows) await savePayments(tx, ctx, 'BUY_SELL', bs.id, p.plan);
    await post(tx, ctx, { id: bs.id, buySellNo, branchId, txnDate }, body, p);
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'CREATED', entity: 'BUY_SELL', entityId: String(bs.id), summary: `Buy-sell #${buySellNo} ${body.side} ${wt(p.totalWeight)}g`, partyName: p.party.name });
    return bs.id;
  });
  return getBuySell(ctx, id);
}

/**
 * Edit = unpost exactly as delete does (reverse ledger/udhar, give the weight back to the old booking), then post the
 * new body (take from the new booking) in ONE tx; same id + trade no. Rejected (409) when the linked booking was
 * cancelled — the same rule delete applies — since its pending weight can't be restored.
 */
export async function updateBuySell(ctx: TenantContext, id: number, body: BuySellBody): Promise<BuySellDto> {
  const sdb = scopedDb(ctx);
  const old = await sdb.buySell.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  if (!old) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  if (old.bhavBookingId != null && (await sdb.bhavBooking.findFirst({ where: { id: old.bhavBookingId }, select: { status: true } }))?.status === 'CANCELLED') {
    throw new HttpError(409, 'CONFLICT', 'The linked bhav booking was cancelled; this trade can no longer be edited');
  }
  const p = await prepare(ctx, body);
  const txnDate = ledger.businessDate(body.txnDate ?? old.txnDate);
  const before = snap({ ...old, payments: await loadPayments(ctx, 'BUY_SELL', id) });

  await prisma.$transaction(async (tx) => {
    await unpost(tx, ctx, old);
    if (body.bhavBookingId != null) await takeFromBooking(tx, body.bhavBookingId, p.totalWeight);
    await tx.buySellLine.deleteMany({ where: { buySellId: id } });
    const after = await tx.buySell.update({
      where: { id },
      data: {
        side: body.side, partyId: body.partyId, metal: body.metal, txnDate, totalWeight: p.totalWeight, discount: body.discount, totalAmount: p.totalAmount,
        cash: p.plan.cash, online: p.plan.online, bankAccountId: p.plan.bankAccountId, bhavBookingId: body.bhavBookingId ?? null, narration: body.narration ?? null,
        lines: { create: p.lines.map((l) => ({ weight: l.weight, rate: l.rate, amount: l.amount })) },
      },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    await savePayments(tx, ctx, 'BUY_SELL', id, p.plan);
    await post(tx, ctx, { id, buySellNo: old.buySellNo, branchId: old.branchId, txnDate }, body, p);
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'EDITED', entity: 'BUY_SELL', entityId: String(id), summary: `Edited buy-sell #${old.buySellNo}`, partyName: p.party.name, meta: { before, after: snap({ ...after, payments: p.plan.rows ?? [] }) } });
  });
  return getBuySell(ctx, id);
}

export async function deleteBuySell(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const bs = await sdb.buySell.findFirst({ where: { id } });
  if (!bs) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  await prisma.$transaction(async (tx) => {
    await unpost(tx, ctx, bs);
    await tx.buySell.delete({ where: { id } }); // cascades lines
    await savePayments(tx, ctx, 'BUY_SELL', id, null);
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'DELETED', entity: 'BUY_SELL', entityId: String(id), summary: `Deleted buy-sell #${bs.buySellNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, bs: any): Promise<BuySellDto> {
  const [refs, payments] = await Promise.all([loadRefs(ctx, bs), loadPayments(ctx, 'BUY_SELL', bs.id)]);
  const booking = bs.bhavBookingId != null ? await scopedDb(ctx).bhavBooking.findFirst({ where: { id: bs.bhavBookingId }, select: { id: true, bookingNo: true } }) : null;
  const bal = D(bs.totalAmount).minus(bs.cash).minus(bs.online);
  return {
    id: bs.id, buySellNo: bs.buySellNo, side: bs.side, party: refs.party, branch: refs.branch, metal: bs.metal, txnDate: dateOnly(bs.txnDate),
    totalWeight: wt(bs.totalWeight), discount: money(bs.discount), totalAmount: money(bs.totalAmount), cash: money(bs.cash), online: money(bs.online), bankAccount: refs.bankAccount,
    balance: money(bs.side === 'BUY' ? bal.negated() : bal), bhavBooking: booking ? { id: booking.id, bookingNo: booking.bookingNo } : null, narration: bs.narration,
    lines: bs.lines.map((l: any) => ({ id: l.id, weight: wt(l.weight), rate: money(l.rate), amount: money(l.amount) })),
    createdBy: refs.createdBy, createdAt: bs.createdAt.toISOString(), payments,
  };
}

export async function getBuySell(ctx: TenantContext, id: number): Promise<BuySellDto> {
  const bs = await scopedDb(ctx).buySell.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  if (!bs) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  return toDto(ctx, bs);
}

export async function buySellHistory(ctx: TenantContext, id: number): Promise<TradeHistoryDto[]> {
  if (!(await scopedDb(ctx).buySell.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  return docHistory(ctx, 'BUY_SELL', id);
}

export async function listBuySell(ctx: TenantContext, query: z.infer<typeof buySellListQuery>): Promise<Paged<BuySellDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { ...(query.side ? { side: query.side } : {}), ...(query.metal ? { metal: query.metal } : {}), ...(query.partyId ? { partyId: query.partyId } : {}), ...dateRange(query) };
  if (query.q) {
    // Same as listExchange: match party name/mobile, or the trade number.
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    const asNo = Number(query.q);
    where.OR = [...(Number.isInteger(asNo) && asNo > 0 && asNo <= 2_147_483_647 ? [{ buySellNo: asNo }] : []), { partyId: { in: parties.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.buySell.findMany({ where, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.buySell.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}
