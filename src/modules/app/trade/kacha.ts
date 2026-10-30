import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import { logActivity } from '../../../lib/activity';
import { assertKachaAvailable, kachaBalance, poolGuard, reservedKacha } from '../../../lib/kacha';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import type { kachaBalanceQuery, kachaListQuery, kachaProcessBody, kachaSummaryQuery } from '../../../shared';
import type { KachaBalanceDto, KachaProcessDto, KachaSummaryDto, Metal, Paged } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, dateRange, lctxOf, lockDoc, metalRow, userName, wt } from './common';

type KachaBody = z.infer<typeof kachaProcessBody>;
/* eslint-disable @typescript-eslint/no-explicit-any */

const srcOf = (type: 'MELT' | 'REFINE') => (type === 'MELT' ? ('EXCHANGE_MELT_PROCESS' as const) : ('EXCHANGE_REFINE' as const));

export async function processKacha(ctx: TenantContext, body: KachaBody): Promise<KachaProcessDto> {
  if (body.type === 'PROCESS') return processBatch(ctx, body);
  const type = body.type;
  const branchId = activeBranch(ctx);
  const inFine = body.inFine!; // contract: required unless PROCESS
  const difference = D(inFine).minus(body.outFine).minus(body.ravalFine); // process loss (negative = gain)
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);
  const source = srcOf(type);

  const id = await prisma.$transaction(async (tx) => {
    // G5 lock order: the related document row first (the linked exchange, or the PROCESS batch refined), then the pools
    if (body.exchangeId != null) await assertLinkedFine(tx, ctx, branchId, body.exchangeId, body.metal, inFine);
    if (body.parentId != null) await assertBatchFine(tx, ctx, branchId, body.parentId, body.metal, inFine);
    const pools = await poolGuard(tx, branchId, [{ metal: body.metal, form: 'KACHA' }, { metal: body.metal, form: 'BULLION' }]);
    const kp = await tx.kachaProcess.create({
      data: {
        businessId: ctx.businessId!, branchId, type, metal: body.metal, txnDate, inFine, outFine: body.outFine, ravalFine: body.ravalFine, difference,
        exchangeId: body.exchangeId ?? null, parentId: body.parentId ?? null, selfDiff: body.selfDiff, remark: body.remark ?? null, createdById: ctx.userId,
      },
    });
    const sid = String(kp.id);
    const rows = [metalRow(source, branchId, txnDate, 'OUT', body.metal, 'KACHA', inFine, inFine, sid, null, `Kacha ${type} #${kp.id}`)];
    if (body.outFine > 0) rows.push(metalRow(source, branchId, txnDate, 'IN', body.metal, 'BULLION', body.outFine, body.outFine, sid, null, `Kacha ${type} #${kp.id}`));
    if (body.ravalFine > 0) rows.push(metalRow(source, branchId, txnDate, 'IN', body.metal, 'KACHA', body.ravalFine, body.ravalFine, sid, null, `Kacha ${type} raval #${kp.id}`));
    await ledger.post(tx, lctx, rows);
    await pools(); // a refine of a batch takes reserved kacha: available stays put (ledger and reservation fall together)
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'CREATED', entity: 'KACHA', entityId: sid, summary: `Kacha ${type} ${wt(inFine)}g${body.parentId != null ? ` of batch #${body.parentId}` : ''}` });
    return kp.id;
  });
  return getKacha(ctx, id);
}

/** Fine of an exchange already taken: Σ its active melts / refines, or all of it while an open PROCESS batch holds it. */
async function usedOf(tx: Prisma.TransactionClient, exchangeId: number, afterFine: Prisma.Decimal.Value) {
  if ((await tx.kachaProcess.count({ where: { reverted: false, type: 'PROCESS', exchangeIds: { has: exchangeId } } })) > 0) return D(afterFine);
  return D((await tx.kachaProcess.aggregate({ where: { reverted: false, type: { not: 'PROCESS' }, exchangeId }, _sum: { inFine: true } }))._sum.inFine ?? 0);
}

/** Lock a linked exchange (document row first) and check it may feed this metal / branch: BUY only, same metal, visible branch. */
async function lockedExchange(tx: Prisma.TransactionClient, ctx: TenantContext, branchId: number, exchangeId: number, metal: Metal) {
  await lockDoc(tx, 'Exchange', exchangeId, ctx.businessId!);
  const ex = await tx.exchange.findUniqueOrThrow({ where: { id: exchangeId }, select: { id: true, exchangeNo: true, branchId: true, side: true, metal: true, afterFine: true, lines: { select: { weight: true } } } });
  if (ex.branchId !== branchId) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found'); // another branch's: not visible here
  if (ex.side !== 'BUY') throw new HttpError(409, 'CONFLICT', `Exchange #${ex.exchangeNo}: only kacha bought in an exchange (BUY) can be processed from it`);
  if (ex.metal !== metal) throw new HttpError(409, 'CONFLICT', `Exchange #${ex.exchangeNo} is ${ex.metal.toLowerCase()}, not ${metal.toLowerCase()}`);
  return ex;
}

/**
 * G5 linked melt: partial melts allowed, but all the non-reverted processes of one exchange together never consume more
 * than its afterFine (no borrowing from other kacha). Runs inside the tx with the exchange row locked.
 */
async function assertLinkedFine(tx: Prisma.TransactionClient, ctx: TenantContext, branchId: number, exchangeId: number, metal: Metal, inFine: number): Promise<void> {
  const ex = await lockedExchange(tx, ctx, branchId, exchangeId, metal);
  const used = await usedOf(tx, exchangeId, ex.afterFine);
  const remaining = D(ex.afterFine).minus(used);
  if (D(inFine).gt(remaining)) {
    throw new HttpError(409, 'CONFLICT', `This exchange has only ${remaining.toFixed(3)} g of its ${D(ex.afterFine).toFixed(3)} g left to process`, { code: 'LINKED_FINE_EXCEEDED', afterFine: D(ex.afterFine).toFixed(3), used: used.toFixed(3), remaining: remaining.toFixed(3) });
  }
}

/** G5 refine of a PROCESS batch: lock the batch row first; open, same metal / branch; Σ its active refines ≤ its reserved fine. */
async function assertBatchFine(tx: Prisma.TransactionClient, ctx: TenantContext, branchId: number, parentId: number, metal: Metal, inFine: number): Promise<void> {
  await lockDoc(tx, 'KachaProcess', parentId, ctx.businessId!);
  const parent = await tx.kachaProcess.findUniqueOrThrow({ where: { id: parentId } });
  if (parent.branchId !== branchId) throw new HttpError(404, 'NOT_FOUND', 'Kacha process not found');
  if (parent.type !== 'PROCESS') throw new HttpError(409, 'CONFLICT', 'Only a process batch can be refined from');
  if (parent.reverted) throw new HttpError(409, 'CONFLICT', 'This process batch was reverted');
  if (parent.metal !== metal) throw new HttpError(409, 'CONFLICT', `The batch is ${parent.metal.toLowerCase()}, not ${metal.toLowerCase()}`);
  const taken = D((await tx.kachaProcess.aggregate({ where: { parentId, reverted: false }, _sum: { inFine: true } }))._sum.inFine ?? 0);
  const left = D(parent.inFine).minus(taken);
  if (D(inFine).gt(left)) throw new HttpError(409, 'CONFLICT', `This batch has only ${left.toFixed(3)} g of its ${D(parent.inFine).toFixed(3)} g left to refine`, { code: 'BATCH_FINE_EXCEEDED', reserved: D(parent.inFine).toFixed(3), refined: taken.toFixed(3), remaining: left.toFixed(3) });
}

/**
 * G5 PROCESS ('send to process'): one atomic batch over whole exchanges. Each must be a BUY of this metal and branch with
 * nothing processed yet; the batch reserves their full fine (no ledger row): melts, sells and bills can no longer draw it,
 * and only a REFINE with parentId = this batch consumes it.
 */
async function processBatch(ctx: TenantContext, body: KachaBody): Promise<KachaProcessDto> {
  const branchId = activeBranch(ctx);
  const ids = [...new Set(body.exchangeIds!)].sort((a, b) => a - b); // one lock order for the documents too
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const id = await prisma.$transaction(async (tx) => {
    const exchanges = [];
    for (const exId of ids) {
      const ex = await lockedExchange(tx, ctx, branchId, exId, body.metal);
      if ((await usedOf(tx, exId, ex.afterFine)).gt(0)) throw new HttpError(409, 'CONFLICT', `Exchange #${ex.exchangeNo} is already (partly) processed`);
      exchanges.push(ex);
    }
    const pools = await poolGuard(tx, branchId, [{ metal: body.metal, form: 'KACHA' }]);
    const inFine = exchanges.reduce((a, e) => a.plus(e.afterFine), D(0));
    const kachaWeight = exchanges.reduce((a, e) => e.lines.reduce((b, l) => b.plus(l.weight), a), D(0));
    const kp = await tx.kachaProcess.create({
      data: {
        businessId: ctx.businessId!, branchId, type: 'PROCESS', metal: body.metal, txnDate, inFine, outFine: 0, ravalFine: 0, difference: 0,
        exchangeId: ids[0]!, exchangeIds: ids, kachaWeight, remark: body.remark ?? null, createdById: ctx.userId,
      },
    });
    await pools(); // the reservation must be covered: kacha the exchanges brought in may already have been drawn elsewhere
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'CREATED', entity: 'KACHA', entityId: String(kp.id), summary: `Kacha PROCESS batch ${wt(inFine)}g (${ids.length} exchange${ids.length === 1 ? '' : 's'})` });
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
    // the process row first (guarded flip): a second revert, or a refine of this batch, waits on it
    const upd = await tx.kachaProcess.updateMany({ where: { id, reverted: false }, data: { reverted: true } });
    if (upd.count !== 1) throw new HttpError(409, 'CONFLICT', 'Already reverted');
    // G5: a batch goes back only after its refines (child before parent)
    if (kp.type === 'PROCESS' && (await tx.kachaProcess.count({ where: { parentId: id, reverted: false } })) > 0) {
      throw new HttpError(409, 'CONFLICT', 'Revert the refines of this batch first');
    }
    // Reverting takes back the bullion produced and the raval kacha added: both pools must still hold them.
    const pools = await poolGuard(tx, kp.branchId, [{ metal: kp.metal, form: 'KACHA' }, { metal: kp.metal, form: 'BULLION' }]);
    // kept from before G5: the raval kacha added back must itself still be there (the pool lock is already held)
    if (D(kp.ravalFine).gt(0)) await assertKachaAvailable(tx, kp.branchId, kp.metal, kp.ravalFine);
    // PROCESS batches post no ledger rows (reverting one just releases its reservation); only MELT/REFINE have rows to reverse.
    if (kp.type !== 'PROCESS') await ledger.reverse(tx, lctx, { source: srcOf(kp.type), sourceId: String(id) });
    await pools();
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'REVERSED', entity: 'KACHA', entityId: String(id), summary: `Reverted kacha ${kp.type} #${id}` });
  });
  return getKacha(ctx, id);
}

export async function kachaBalanceCard(ctx: TenantContext, query: z.infer<typeof kachaBalanceQuery>): Promise<KachaBalanceDto> {
  const branchId = activeBranch(ctx);
  const card = async (metal: Metal) => {
    const [{ kacha, bullion }, reserved] = await Promise.all([kachaBalance(prisma, branchId, metal), reservedKacha(prisma, branchId, metal)]);
    return { metal, kachaFine: wt(kacha), bullionFine: wt(bullion), reservedFine: wt(reserved) };
  };
  if (query.metal) return card(query.metal);
  // All metals: each metal separately (never summed across metals); top level stays GOLD for older readers.
  const byMetal = await Promise.all((['GOLD', 'SILVER'] as const).map(card));
  return { ...byMetal[0]!, byMetal };
}

/** G5 summary cards: non-reverted processes of the active branch by type (Σ kacha out, bullion in, raval, difference, self diff). */
export async function kachaSummary(ctx: TenantContext, query: z.infer<typeof kachaSummaryQuery>): Promise<KachaSummaryDto> {
  const branchId = activeBranch(ctx);
  const where = { branchId, reverted: false, ...(query.metal ? { metal: query.metal } : {}), ...dateRange(query) };
  const [groups, reserved] = await Promise.all([
    scopedDb(ctx).kachaProcess.groupBy({ by: ['type'], where, _count: { _all: true }, _sum: { inFine: true, outFine: true, ravalFine: true, difference: true, selfDiff: true } }),
    query.metal ? reservedKacha(prisma, branchId, query.metal) : Promise.all((['GOLD', 'SILVER'] as const).map((m) => reservedKacha(prisma, branchId, m))).then((r) => r.reduce((a, x) => a.plus(x), D(0))),
  ]);
  return {
    metal: query.metal ?? null,
    byType: (['MELT', 'REFINE', 'PROCESS'] as const).map((type) => {
      const g = groups.find((x) => x.type === type);
      return { type, count: g?._count._all ?? 0, inFine: wt(g?._sum.inFine), outFine: wt(g?._sum.outFine), ravalFine: wt(g?._sum.ravalFine), difference: wt(g?._sum.difference), selfDiff: wt(g?._sum.selfDiff) };
    }),
    reservedFine: wt(reserved),
  };
}

// ───────────── DTO + list/get ─────────────

async function toDto(ctx: TenantContext, kp: any, detail = false): Promise<KachaProcessDto> {
  const sdb = scopedDb(ctx);
  const exIds: number[] = kp.type === 'PROCESS' ? kp.exchangeIds : kp.exchangeId != null ? [kp.exchangeId] : [];
  const exs = exIds.length ? await sdb.exchange.findMany({ where: { id: { in: exIds } }, select: { id: true, exchangeNo: true }, orderBy: { id: 'asc' } }) : [];
  const ex = kp.exchangeId != null ? exs.find((e) => e.id === kp.exchangeId) ?? null : null;
  const base: KachaProcessDto = {
    id: kp.id, type: kp.type, metal: kp.metal, txnDate: dateOnly(kp.txnDate), inFine: wt(kp.inFine), outFine: wt(kp.outFine), ravalFine: wt(kp.ravalFine), difference: wt(kp.difference),
    exchange: ex ? { id: ex.id, exchangeNo: ex.exchangeNo } : null, remark: kp.remark, reverted: kp.reverted, createdBy: await userName(ctx, kp.createdById), createdAt: kp.createdAt.toISOString(),
    selfDiff: wt(kp.selfDiff), parentId: kp.parentId,
  };
  if (kp.type !== 'PROCESS') return base;
  const children = await sdb.kachaProcess.findMany({ where: { parentId: kp.id }, orderBy: { id: 'asc' } });
  const refined = children.filter((c) => !c.reverted).reduce((a, c) => a.plus(c.inFine), D(0));
  return {
    ...base, exchanges: exs, kachaWeight: kp.kachaWeight != null ? wt(kp.kachaWeight) : null,
    reservedFine: kp.reverted ? wt(0) : wt(max0(D(kp.inFine).minus(refined))),
    ...(detail ? { children: await Promise.all(children.map((c) => toDto(ctx, c))) } : {}),
  };
}
const max0 = (d: ReturnType<typeof D>) => (d.isNegative() ? D(0) : d);

export async function getKacha(ctx: TenantContext, id: number): Promise<KachaProcessDto> {
  const kp = await scopedDb(ctx).kachaProcess.findFirst({ where: { id } });
  if (!kp) throw new HttpError(404, 'NOT_FOUND', 'Kacha process not found');
  return toDto(ctx, kp, true);
}

export async function listKacha(ctx: TenantContext, query: z.infer<typeof kachaListQuery>): Promise<Paged<KachaProcessDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { ...(query.metal ? { metal: query.metal } : {}), ...(query.type ? { type: query.type } : {}), ...(query.parentId ? { parentId: query.parentId } : {}) };
  const [rows, total] = await Promise.all([
    sdb.kachaProcess.findMany({ where, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.kachaProcess.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => toDto(ctx, r))), total, page: query.page, pageSize: query.pageSize };
}

export type { Metal };
