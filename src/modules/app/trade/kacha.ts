import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { logActivity } from '../../../lib/activity';
import { assertKachaAvailable, kachaBalance, poolGuard } from '../../../lib/kacha';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import type { kachaBalanceQuery, kachaListQuery, kachaProcessBody } from '../../../shared';
import type { KachaBalanceDto, KachaProcessDto, Metal, Paged } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, lctxOf, lockDoc, metalRow, userName, wt } from './common';

type KachaBody = z.infer<typeof kachaProcessBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

const srcOf = (type: 'MELT' | 'REFINE') => (type === 'MELT' ? ('EXCHANGE_MELT_PROCESS' as const) : ('EXCHANGE_REFINE' as const));

export async function processKacha(ctx: TenantContext, body: KachaBody): Promise<KachaProcessDto> {
  const branchId = activeBranch(ctx);
  const difference = D(body.inFine).minus(body.outFine).minus(body.ravalFine); // process loss (negative = gain)
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);
  const source = srcOf(body.type);

  const id = await prisma.$transaction(async (tx) => {
    // G5 lock order: the linked exchange row first (melts of one exchange serialize), then the pools
    if (body.exchangeId != null) await assertLinkedFine(tx, ctx, branchId, body);
    const pools = await poolGuard(tx, branchId, [{ metal: body.metal, form: 'KACHA' }, { metal: body.metal, form: 'BULLION' }]);
    const kp = await tx.kachaProcess.create({
      data: { businessId: ctx.businessId!, branchId, type: body.type, metal: body.metal, txnDate, inFine: body.inFine, outFine: body.outFine, ravalFine: body.ravalFine, difference, exchangeId: body.exchangeId ?? null, remark: body.remark ?? null, createdById: ctx.userId },
    });
    const sid = String(kp.id);
    const rows = [metalRow(source, branchId, txnDate, 'OUT', body.metal, 'KACHA', body.inFine, body.inFine, sid, null, `Kacha ${body.type} #${kp.id}`)];
    if (body.outFine > 0) rows.push(metalRow(source, branchId, txnDate, 'IN', body.metal, 'BULLION', body.outFine, body.outFine, sid, null, `Kacha ${body.type} #${kp.id}`));
    if (body.ravalFine > 0) rows.push(metalRow(source, branchId, txnDate, 'IN', body.metal, 'KACHA', body.ravalFine, body.ravalFine, sid, null, `Kacha ${body.type} raval #${kp.id}`));
    await ledger.post(tx, lctx, rows);
    await pools();
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'CREATED', entity: 'KACHA', entityId: sid, summary: `Kacha ${body.type} ${wt(body.inFine)}g` });
    return kp.id;
  });
  return getKacha(ctx, id);
}

/**
 * G5 linked melt: only kacha bought in an exchange (BUY) of the same metal and branch; partial melts allowed, but all the
 * non-reverted processes of one exchange together never consume more than its afterFine (no borrowing from other kacha).
 * Runs inside the tx with the exchange row locked, so two melts of one exchange can't both pass.
 */
async function assertLinkedFine(tx: Prisma.TransactionClient, ctx: TenantContext, branchId: number, body: KachaBody): Promise<void> {
  const exchangeId = body.exchangeId!;
  await lockDoc(tx, 'Exchange', exchangeId, ctx.businessId!);
  const ex = await tx.exchange.findUniqueOrThrow({ where: { id: exchangeId }, select: { branchId: true, side: true, metal: true, afterFine: true } });
  if (ex.branchId !== branchId) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found'); // another branch's: not visible here
  if (ex.side !== 'BUY') throw new HttpError(409, 'CONFLICT', 'Only kacha bought in an exchange (BUY) can be processed from it');
  if (ex.metal !== body.metal) throw new HttpError(409, 'CONFLICT', `The exchange is ${ex.metal.toLowerCase()}, not ${body.metal.toLowerCase()}`);
  const used = (await tx.kachaProcess.aggregate({ where: { reverted: false, OR: [{ exchangeId }, { exchangeIds: { has: exchangeId } }] }, _sum: { inFine: true } }))._sum.inFine ?? 0;
  const remaining = D(ex.afterFine).minus(used);
  if (D(body.inFine).gt(remaining)) {
    throw new HttpError(409, 'CONFLICT', `This exchange has only ${remaining.toFixed(3)} g of its ${D(ex.afterFine).toFixed(3)} g left to process`, { code: 'LINKED_FINE_EXCEEDED', afterFine: D(ex.afterFine).toFixed(3), used: D(used).toFixed(3), remaining: remaining.toFixed(3) });
  }
}

export async function revertKacha(ctx: TenantContext, id: number): Promise<KachaProcessDto> {
  const sdb = scopedDb(ctx);
  const kp = await sdb.kachaProcess.findFirst({ where: { id } });
  if (!kp) throw new HttpError(404, 'NOT_FOUND', 'Kacha process not found');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    const upd = await tx.kachaProcess.updateMany({ where: { id, reverted: false }, data: { reverted: true } });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Already reverted');
    // Reverting takes back the bullion produced and the raval kacha added: both pools must still hold them.
    const pools = await poolGuard(tx, kp.branchId, [{ metal: kp.metal, form: 'KACHA' }, { metal: kp.metal, form: 'BULLION' }]);
    // kept from before G5: the raval kacha added back must itself still be there (the pool lock is already held)
    if (D(kp.ravalFine).gt(0)) await assertKachaAvailable(tx, kp.branchId, kp.metal, kp.ravalFine);
    // PROCESS batches post no ledger rows (schema KachaProcessType.PROCESS); only MELT/REFINE have rows to reverse.
    if (kp.type !== 'PROCESS') await ledger.reverse(tx, lctx, { source: srcOf(kp.type), sourceId: String(id) });
    await pools();
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'REVERSED', entity: 'KACHA', entityId: String(id), summary: `Reverted kacha ${kp.type} #${id}` });
  });
  return getKacha(ctx, id);
}

export async function kachaBalanceCard(ctx: TenantContext, query: z.infer<typeof kachaBalanceQuery>): Promise<KachaBalanceDto> {
  const branchId = activeBranch(ctx);
  if (query.metal) {
    const { kacha, bullion } = await kachaBalance(prisma, branchId, query.metal);
    return { metal: query.metal, kachaFine: wt(kacha), bullionFine: wt(bullion) };
  }
  // All metals: each metal separately (never summed across metals); top level stays GOLD for older readers.
  const byMetal = await Promise.all((['GOLD', 'SILVER'] as const).map(async (metal) => {
    const { kacha, bullion } = await kachaBalance(prisma, branchId, metal);
    return { metal, kachaFine: wt(kacha), bullionFine: wt(bullion) };
  }));
  return { ...byMetal[0]!, byMetal };
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, kp: any): Promise<KachaProcessDto> {
  const ex = kp.exchangeId != null ? await scopedDb(ctx).exchange.findFirst({ where: { id: kp.exchangeId }, select: { id: true, exchangeNo: true } }) : null;
  return {
    id: kp.id, type: kp.type, metal: kp.metal, txnDate: dateOnly(kp.txnDate), inFine: wt(kp.inFine), outFine: wt(kp.outFine), ravalFine: wt(kp.ravalFine), difference: wt(kp.difference),
    exchange: ex ? { id: ex.id, exchangeNo: ex.exchangeNo } : null, remark: kp.remark, reverted: kp.reverted, createdBy: await userName(ctx, kp.createdById), createdAt: kp.createdAt.toISOString(),
  };
}

async function getKacha(ctx: TenantContext, id: number): Promise<KachaProcessDto> {
  const kp = await scopedDb(ctx).kachaProcess.findFirst({ where: { id } });
  if (!kp) throw new HttpError(404, 'NOT_FOUND', 'Kacha process not found');
  return toDto(ctx, kp);
}

export async function listKacha(ctx: TenantContext, query: z.infer<typeof kachaListQuery>): Promise<Paged<KachaProcessDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { ...(query.metal ? { metal: query.metal } : {}), ...(query.type ? { type: query.type } : {}) };
  const [rows, total] = await Promise.all([
    sdb.kachaProcess.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.kachaProcess.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}

export type { Metal };
