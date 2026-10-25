import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { logActivity } from '../../../lib/activity';
import { assertKachaAvailable, kachaBalance } from '../../../lib/kacha';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import type { kachaBalanceQuery, kachaListQuery, kachaProcessBody } from '../../../shared';
import type { KachaBalanceDto, KachaProcessDto, Metal, Paged } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, lctxOf, metalRow, userName, wt } from './common';

type KachaBody = z.infer<typeof kachaProcessBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

const srcOf = (type: 'MELT' | 'REFINE') => (type === 'MELT' ? ('EXCHANGE_MELT_PROCESS' as const) : ('EXCHANGE_REFINE' as const));

export async function processKacha(ctx: TenantContext, body: KachaBody): Promise<KachaProcessDto> {
  const branchId = activeBranch(ctx);
  if (body.exchangeId != null && !(await scopedDb(ctx).exchange.findFirst({ where: { id: body.exchangeId }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  const difference = D(body.inFine).minus(body.outFine).minus(body.ravalFine); // process loss (negative = gain)
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);
  const source = srcOf(body.type);

  const id = await prisma.$transaction(async (tx) => {
    await assertKachaAvailable(tx, branchId, body.metal, body.inFine);
    const kp = await tx.kachaProcess.create({
      data: { businessId: ctx.businessId!, branchId, type: body.type, metal: body.metal, txnDate, inFine: body.inFine, outFine: body.outFine, ravalFine: body.ravalFine, difference, exchangeId: body.exchangeId ?? null, remark: body.remark ?? null, createdById: ctx.userId },
    });
    const sid = String(kp.id);
    const rows = [metalRow(source, branchId, txnDate, 'OUT', body.metal, 'KACHA', body.inFine, body.inFine, sid, null, `Kacha ${body.type} #${kp.id}`)];
    if (body.outFine > 0) rows.push(metalRow(source, branchId, txnDate, 'IN', body.metal, 'BULLION', body.outFine, body.outFine, sid, null, `Kacha ${body.type} #${kp.id}`));
    if (body.ravalFine > 0) rows.push(metalRow(source, branchId, txnDate, 'IN', body.metal, 'KACHA', body.ravalFine, body.ravalFine, sid, null, `Kacha ${body.type} raval #${kp.id}`));
    await ledger.post(tx, lctx, rows);
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'CREATED', entity: 'KACHA', entityId: sid, summary: `Kacha ${body.type} ${wt(body.inFine)}g` });
    return kp.id;
  });
  return getKacha(ctx, id);
}

export async function revertKacha(ctx: TenantContext, id: number): Promise<KachaProcessDto> {
  const sdb = scopedDb(ctx);
  const kp = await sdb.kachaProcess.findFirst({ where: { id } });
  if (!kp) throw new HttpError(404, 'NOT_FOUND', 'Kacha process not found');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    const upd = await tx.kachaProcess.updateMany({ where: { id, reverted: false }, data: { reverted: true } });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Already reverted');
    // Reverting removes the raval kacha that was added back — the pool must still hold it.
    if (D(kp.ravalFine).gt(0)) await assertKachaAvailable(tx, kp.branchId, kp.metal, kp.ravalFine);
    await ledger.reverse(tx, lctx, { source: srcOf(kp.type), sourceId: String(id) });
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'REVERSED', entity: 'KACHA', entityId: String(id), summary: `Reverted kacha ${kp.type} #${id}` });
  });
  return getKacha(ctx, id);
}

export async function kachaBalanceCard(ctx: TenantContext, query: z.infer<typeof kachaBalanceQuery>): Promise<KachaBalanceDto> {
  const branchId = activeBranch(ctx);
  const { kacha, bullion } = await kachaBalance(prisma, branchId, query.metal);
  return { metal: query.metal, kachaFine: wt(kacha), bullionFine: wt(bullion) };
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
  const where: any = { ...(query.metal ? { metal: query.metal } : {}) };
  const [rows, total] = await Promise.all([
    sdb.kachaProcess.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.kachaProcess.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}

export type { Metal };
