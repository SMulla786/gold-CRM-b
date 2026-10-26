import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { assertKachaAvailable } from '../../../lib/kacha';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { exchangeBody, exchangeListQuery, fineWeight, metalToMoney } from '../../../shared';
import type { ExchangeDto, Paged } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, assertBank, dateOnly, lctxOf, loadRefs, metalRow, money, moneyRows, nextNo, partyRef, settingsUnit, userName, wt } from './common';

type ExchangeBody = z.infer<typeof exchangeBody>;

export async function createExchange(ctx: TenantContext, body: ExchangeBody): Promise<ExchangeDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  await assertBank(ctx, body.online, body.bankAccountId);
  const unit = await settingsUnit(ctx, body.metal);

  const lines = body.lines.map((l) => ({ ...l, fine: D(fineWeight(l.weight, l.touch)) }));
  const totalFine = lines.reduce((a, l) => a.plus(l.fine), D(0));
  const totalWeight = lines.reduce((a, l) => a.plus(l.weight), D(0));
  const afterFine = totalFine.plus(body.diffFine);
  if (afterFine.lte(0)) throw new HttpError(400, 'VALIDATION', 'After-difference fine must be positive');
  const finalAmount = body.rate > 0 ? D(metalToMoney(afterFine, body.rate, unit)).plus(body.charges).minus(body.discount) : D(0);

  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);

  const id = await prisma.$transaction(async (tx) => {
    const exchangeNo = await nextNo(tx, ctx.businessId!, branchId, 'EXCHANGE');
    const ex = await tx.exchange.create({
      data: {
        businessId: ctx.businessId!, branchId, exchangeNo, side: body.side, partyId: body.partyId, metal: body.metal, txnDate,
        totalFine, diffFine: body.diffFine, afterFine, rate: body.rate, charges: body.charges, discount: body.discount, finalAmount,
        cash: body.cash, online: body.online, bankAccountId: body.online > 0 ? body.bankAccountId! : null, remark: body.remark ?? null, createdById: ctx.userId,
        lines: { create: lines.map((l) => ({ weight: l.weight, touch: l.touch, fine: l.fine, serialNo: l.serialNo ?? null })) },
      },
    });
    const sid = String(ex.id);
    const sellOut = body.side === 'SELL';
    if (sellOut) await assertKachaAvailable(tx, branchId, body.metal, afterFine); // can't sell more kacha than the pool holds

    const rows = [metalRow('EXCHANGE', branchId, txnDate, sellOut ? 'OUT' : 'IN', body.metal, 'KACHA', totalWeight, afterFine, sid, body.partyId, `Exchange #${exchangeNo}`)];
    rows.push(...moneyRows('EXCHANGE', branchId, txnDate, sellOut ? 'IN' : 'OUT', body.cash, body.online, body.bankAccountId ?? null, sid, body.partyId, `Exchange #${exchangeNo}`));
    await ledger.post(tx, lctx, rows);

    if (body.rate > 0) {
      const remaining = finalAmount.minus(body.cash).minus(body.online); // >0 = unsettled money value of the trade
      if (!remaining.isZero()) await udhar.post(tx, lctx, [{ branchId, partyId: body.partyId, txnDate, amount: sellOut ? remaining : remaining.negated(), source: 'EXCHANGE', sourceId: sid, narration: `Exchange #${exchangeNo}` }]);
    } else {
      const m = sellOut ? afterFine : afterFine.negated(); // BUY: shop owes the metal (party credit); SELL: party owes it
      await udhar.post(tx, lctx, [{ branchId, partyId: body.partyId, txnDate, gold: body.metal === 'GOLD' ? m : 0, silver: body.metal === 'SILVER' ? m : 0, source: 'EXCHANGE', sourceId: sid, narration: `Exchange #${exchangeNo}` }]);
    }
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'CREATED', entity: 'EXCHANGE', entityId: sid, summary: `Exchange #${exchangeNo} ${body.side} ${wt(afterFine)}g`, partyName: party.name });
    return ex.id;
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
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'DELETED', entity: 'EXCHANGE', entityId: String(id), summary: `Deleted exchange #${ex.exchangeNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, ex: any): Promise<ExchangeDto> {
  const refs = await loadRefs(ctx, ex);
  const processed = (await scopedDb(ctx).kachaProcess.count({ where: { exchangeId: ex.id, reverted: false } })) > 0;
  const bal = D(ex.finalAmount).minus(ex.cash).minus(ex.online);
  return {
    id: ex.id, exchangeNo: ex.exchangeNo, side: ex.side, party: refs.party, branch: refs.branch, metal: ex.metal, txnDate: dateOnly(ex.txnDate),
    totalFine: wt(ex.totalFine), diffFine: wt(ex.diffFine), afterFine: wt(ex.afterFine), rate: money(ex.rate), charges: money(ex.charges), discount: money(ex.discount),
    finalAmount: money(ex.finalAmount), cash: money(ex.cash), online: money(ex.online), bankAccount: refs.bankAccount,
    balance: money(ex.side === 'BUY' ? bal.negated() : bal), remark: ex.remark,
    lines: ex.lines.map((l: any) => ({ id: l.id, weight: wt(l.weight), touch: String(l.touch), fine: wt(l.fine), serialNo: l.serialNo })),
    processed, createdBy: refs.createdBy, createdAt: ex.createdAt.toISOString(),
  };
}

export async function getExchange(ctx: TenantContext, id: number): Promise<ExchangeDto> {
  const ex = await scopedDb(ctx).exchange.findFirst({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
  if (!ex) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  return toDto(ctx, ex);
}

export async function listExchange(ctx: TenantContext, query: z.infer<typeof exchangeListQuery>): Promise<Paged<ExchangeDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { ...(query.side ? { side: query.side } : {}), ...(query.metal ? { metal: query.metal } : {}), ...(query.partyId ? { partyId: query.partyId } : {}) };
  if (query.q) {
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    const asNo = Number(query.q);
    where.OR = [...(Number.isInteger(asNo) && asNo > 0 && asNo <= 2_147_483_647 ? [{ exchangeNo: asNo }] : []), { partyId: { in: parties.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.exchange.findMany({ where, include: { lines: { orderBy: { id: 'asc' } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.exchange.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}
