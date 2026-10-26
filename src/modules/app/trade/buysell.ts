import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { buySellBody, buySellListQuery, metalToMoney } from '../../../shared';
import type { BuySellDto, Paged } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, assertBank, dateOnly, lctxOf, loadRefs, metalRow, money, moneyRows, nextNo, settingsUnit, wt } from './common';

type BuySellBody = z.infer<typeof buySellBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function createBuySell(ctx: TenantContext, body: BuySellBody): Promise<BuySellDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  await assertBank(ctx, body.online, body.bankAccountId);
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

  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);
  const buyIn = body.side === 'BUY'; // shop buys bullion in, pays out

  const id = await prisma.$transaction(async (tx) => {
    if (body.bhavBookingId != null) {
      // Decrement the pending weight atomically; must still be open and have enough pending.
      const dec = await tx.bhavBooking.updateMany({ where: { id: body.bhavBookingId, status: { in: ['PENDING', 'PARTIAL'] }, pendingWeight: { gte: totalWeight } }, data: { pendingWeight: { decrement: totalWeight } } });
      if (dec.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking is not open or lacks the pending weight');
      const fresh = await tx.bhavBooking.findUniqueOrThrow({ where: { id: body.bhavBookingId } });
      await tx.bhavBooking.update({ where: { id: body.bhavBookingId }, data: { status: D(fresh.pendingWeight).isZero() ? 'DELIVERED' : 'PARTIAL' } });
    }
    const buySellNo = await nextNo(tx, ctx.businessId!, branchId, 'BUY_SELL');
    const bs = await tx.buySell.create({
      data: {
        businessId: ctx.businessId!, branchId, buySellNo, side: body.side, partyId: body.partyId, metal: body.metal, txnDate, totalWeight, discount: body.discount, totalAmount,
        cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, bhavBookingId: body.bhavBookingId ?? null, narration: body.narration ?? null, createdById: ctx.userId,
        lines: { create: lines.map((l) => ({ weight: l.weight, rate: l.rate, amount: l.amount })) },
      },
    });
    const sid = String(bs.id);
    const rows = [metalRow('BUY_SELL', branchId, txnDate, buyIn ? 'IN' : 'OUT', body.metal, 'BULLION', totalWeight, totalWeight, sid, body.partyId, `Buy-sell #${buySellNo}`)];
    rows.push(...moneyRows('BUY_SELL', branchId, txnDate, buyIn ? 'OUT' : 'IN', body.cash, body.online, body.bankAccountId ?? null, sid, body.partyId, `Buy-sell #${buySellNo}`));
    await ledger.post(tx, lctx, rows);
    const remaining = totalAmount.minus(body.cash).minus(body.online);
    if (!remaining.isZero()) await udhar.post(tx, lctx, [{ branchId, partyId: body.partyId, txnDate, amount: buyIn ? remaining.negated() : remaining, source: 'BUY_SELL', sourceId: sid, narration: `Buy-sell #${buySellNo}` }]);
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'CREATED', entity: 'BUY_SELL', entityId: sid, summary: `Buy-sell #${buySellNo} ${body.side} ${wt(totalWeight)}g`, partyName: party.name });
    return bs.id;
  });
  return getBuySell(ctx, id);
}

export async function deleteBuySell(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const bs = await sdb.buySell.findFirst({ where: { id } });
  if (!bs) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    await ledger.reverse(tx, lctx, { source: 'BUY_SELL', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'BUY_SELL', sourceId: String(id) });
    if (bs.bhavBookingId != null) {
      // Atomic increment (not read-then-write) so concurrent deletes on the same booking don't lose a restore.
      const rec = await tx.bhavBooking.updateMany({ where: { id: bs.bhavBookingId, status: { not: 'CANCELLED' } }, data: { pendingWeight: { increment: bs.totalWeight } } });
      if (rec.count !== 1) throw new HttpError(409, 'CONFLICT', 'Booking was cancelled; cannot restore pending weight');
      const fresh = await tx.bhavBooking.findUniqueOrThrow({ where: { id: bs.bhavBookingId } });
      await tx.bhavBooking.update({ where: { id: bs.bhavBookingId }, data: { status: D(fresh.pendingWeight).equals(fresh.weight) ? 'PENDING' : 'PARTIAL' } });
    }
    await tx.buySell.delete({ where: { id } }); // cascades lines
    await logActivity(tx, ctx, { module: 'BUY_SELL', action: 'DELETED', entity: 'BUY_SELL', entityId: String(id), summary: `Deleted buy-sell #${bs.buySellNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, bs: any): Promise<BuySellDto> {
  const refs = await loadRefs(ctx, bs);
  const booking = bs.bhavBookingId != null ? await scopedDb(ctx).bhavBooking.findFirst({ where: { id: bs.bhavBookingId }, select: { id: true, bookingNo: true } }) : null;
  const bal = D(bs.totalAmount).minus(bs.cash).minus(bs.online);
  return {
    id: bs.id, buySellNo: bs.buySellNo, side: bs.side, party: refs.party, branch: refs.branch, metal: bs.metal, txnDate: dateOnly(bs.txnDate),
    totalWeight: wt(bs.totalWeight), discount: money(bs.discount), totalAmount: money(bs.totalAmount), cash: money(bs.cash), online: money(bs.online), bankAccount: refs.bankAccount,
    balance: money(bs.side === 'BUY' ? bal.negated() : bal), bhavBooking: booking ? { id: booking.id, bookingNo: booking.bookingNo } : null, narration: bs.narration,
    lines: bs.lines.map((l: any) => ({ id: l.id, weight: wt(l.weight), rate: money(l.rate), amount: money(l.amount) })),
    createdBy: refs.createdBy, createdAt: bs.createdAt.toISOString(),
  };
}

export async function getBuySell(ctx: TenantContext, id: number): Promise<BuySellDto> {
  const bs = await scopedDb(ctx).buySell.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  if (!bs) throw new HttpError(404, 'NOT_FOUND', 'Buy-sell not found');
  return toDto(ctx, bs);
}

export async function listBuySell(ctx: TenantContext, query: z.infer<typeof buySellListQuery>): Promise<Paged<BuySellDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { ...(query.side ? { side: query.side } : {}), ...(query.metal ? { metal: query.metal } : {}), ...(query.partyId ? { partyId: query.partyId } : {}) };
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
