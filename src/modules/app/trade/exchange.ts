import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { poolGuard } from '../../../lib/kacha';
import { HttpError } from '../../../middleware/error';
import type { z } from 'zod';
import { exchangeBody, exchangeListQuery, fineWeight, metalToMoney, roundMoney } from '../../../shared';
import { getSettings } from '../service';
import { checkInlineUdhar, inlineUdharDto, syncInlineUdhar } from '../udhar';
import type { ExchangeDto, Paged, TradeHistoryDto } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { D, activeBranch, dateOnly, dateRange, docHistory, lctxOf, loadPayments, loadRefs, lockDoc, metalRow, money, nextNo, payPlan, payRows, savePayments, settingsUnit, snap, wt } from './common';

type ExchangeBody = z.infer<typeof exchangeBody>;

/** Validate a body and work out its figures (shared by create and edit). */
async function prepare(ctx: TenantContext, body: ExchangeBody) {
  const party = await scopedDb(ctx).party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const plan = await payPlan(ctx, body);
  const unit = await settingsUnit(ctx, body.metal);
  const defaults = (await getSettings(ctx))['exchange.defaults'];
  // G5 weighing block: a linked sample must be this business's; its custody is untouched (issue / return own that)
  const sampleIds = [...new Set(body.lines.map((l) => l.sampleId).filter((x): x is number => x != null))];
  if (sampleIds.length && (await scopedDb(ctx).sample.count({ where: { id: { in: sampleIds } } })) !== sampleIds.length) throw new HttpError(404, 'NOT_FOUND', 'Sample not found');

  const lines = body.lines.map((l) => ({ ...l, fine: D(fineWeight(l.weight, l.touch)) }));
  const totalFine = lines.reduce((a, l) => a.plus(l.fine), D(0)); // exact fine: never rounded
  const totalWeight = lines.reduce((a, l) => a.plus(l.weight), D(0));
  // G5 difference, computed here from its parts (% of the WEIGHT | FINE base + grams, each side); a body with only the
  // legacy signed diffFine counts it as grams on its side
  const legacy = body.diffPctPlus === undefined && body.diffGmPlus === undefined && body.diffPctMinus === undefined && body.diffGmMinus === undefined;
  const diff = {
    pctPlus: D(body.diffPctPlus ?? 0), gmPlus: D(legacy ? Math.max(body.diffFine, 0) : (body.diffGmPlus ?? 0)),
    pctMinus: D(body.diffPctMinus ?? 0), gmMinus: D(legacy ? Math.max(-body.diffFine, 0) : (body.diffGmMinus ?? 0)),
    by: legacy ? null : defaults.diffBy,
  };
  const base = defaults.diffBy === 'WEIGHT' ? totalWeight : totalFine;
  // 3 dp = the stored precision of every fine column
  const diffFine = base.times(diff.pctPlus).div(100).plus(diff.gmPlus).minus(base.times(diff.pctMinus).div(100)).minus(diff.gmMinus).toDecimalPlaces(3);
  const afterFine = totalFine.plus(diffFine);
  if (afterFine.lte(0)) throw new HttpError(400, 'VALIDATION', 'After-difference fine must be positive');
  // G5 given metal: the customer's metal comes in as kacha by its fine and is settled with the party — a SELL takes that
  // much less from the shop, a BUY is owed that much more
  const given = body.given ? { gross: D(body.given.gross), net: D(body.given.gross).minus(body.given.less), touch: D(body.given.touch) } : null;
  const givenFine = given ? D(fineWeight(given.net, given.touch)) : D(0);
  const settleFine = body.side === 'SELL' ? afterFine.minus(givenFine) : afterFine.plus(givenFine);
  if (settleFine.lt(0)) throw new HttpError(400, 'VALIDATION', 'The given metal is more than the party takes; record it as a BUY exchange');
  const exact = body.rate > 0 ? D(metalToMoney(settleFine, body.rate, unit)).plus(body.charges).minus(body.discount) : D(0);
  const rounded = body.rate > 0 ? roundMoney(exact, defaults.roundOff, defaults.roundStep) : { final: '0', round: '0' };
  if (body.udhar) await checkInlineUdhar(ctx, body.partyId, body.udhar); // TRD-02
  return { party, plan, lines, totalFine, totalWeight, diff, diffFine, afterFine, given, givenFine, settleFine, finalAmount: D(rounded.final), roundOff: D(rounded.round) };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

const docData = (body: ExchangeBody, p: Prepared) => ({
  side: body.side, partyId: body.partyId, metal: body.metal,
  totalFine: p.totalFine, exactFine: p.totalFine, diffFine: p.diffFine, afterFine: p.afterFine,
  diffPctPlus: p.diff.pctPlus, diffGmPlus: p.diff.gmPlus, diffPctMinus: p.diff.pctMinus, diffGmMinus: p.diff.gmMinus, diffPlusBy: p.diff.by, diffMinusBy: p.diff.by,
  givenFine: p.givenFine, givenGross: p.given?.gross ?? null, givenNet: p.given?.net ?? null, givenTouch: p.given?.touch ?? null,
  rate: body.rate, charges: body.charges, discount: body.discount, finalAmount: p.finalAmount, roundOff: p.roundOff,
  cash: p.plan.cash, online: p.plan.online, bankAccountId: p.plan.bankAccountId, remark: body.remark ?? null,
  lines: {
    create: p.lines.map((l) => ({
      weight: l.weight, touch: l.touch, fine: l.fine, serialNo: l.serialNo ?? null,
      grossWeight: l.grossWeight ?? null, lessWeight: l.lessWeight ?? null, meltWeight: l.meltWeight ?? null, sampleWeight: l.sampleWeight ?? null, sampleId: l.sampleId ?? null,
    })),
  },
});

/** Ledger + udhar postings of an exchange (create and the re-post half of an edit); all under one sourceId, so delete / edit reverse exactly. */
async function post(tx: Prisma.TransactionClient, ctx: TenantContext, doc: { id: number; exchangeNo: number; branchId: number; txnDate: Date }, body: ExchangeBody, p: Prepared) {
  const lctx = lctxOf(ctx);
  const sid = String(doc.id);
  const sellOut = body.side === 'SELL';
  const rows = [metalRow('EXCHANGE', doc.branchId, doc.txnDate, sellOut ? 'OUT' : 'IN', body.metal, 'KACHA', p.totalWeight, p.afterFine, sid, body.partyId, `Exchange #${doc.exchangeNo}`)];
  if (p.given) rows.push(metalRow('EXCHANGE', doc.branchId, doc.txnDate, 'IN', body.metal, 'KACHA', p.given.net, p.givenFine, sid, body.partyId, `Exchange #${doc.exchangeNo} given metal`));
  rows.push(...payRows(p.plan, 'EXCHANGE', doc.branchId, doc.txnDate, sellOut ? 'IN' : 'OUT', sid, body.partyId, `Exchange #${doc.exchangeNo}`));
  await ledger.post(tx, lctx, rows);

  if (body.rate > 0) {
    const remaining = p.finalAmount.minus(p.plan.cash).minus(p.plan.online); // >0 = unsettled money value of the trade
    if (!remaining.isZero()) await udhar.post(tx, lctx, [{ branchId: doc.branchId, partyId: body.partyId, txnDate: doc.txnDate, amount: sellOut ? remaining : remaining.negated(), source: 'EXCHANGE', sourceId: sid, narration: `Exchange #${doc.exchangeNo}` }]);
  } else {
    const m = sellOut ? p.settleFine : p.settleFine.negated(); // BUY: shop owes the metal (party credit); SELL: party owes it (given metal included)
    await udhar.post(tx, lctx, [{ branchId: doc.branchId, partyId: body.partyId, txnDate: doc.txnDate, gold: body.metal === 'GOLD' ? m : 0, silver: body.metal === 'SILVER' ? m : 0, source: 'EXCHANGE', sourceId: sid, narration: `Exchange #${doc.exchangeNo}` }]);
  }
}

export async function createExchange(ctx: TenantContext, body: ExchangeBody): Promise<ExchangeDto> {
  const branchId = activeBranch(ctx);
  const p = await prepare(ctx, body);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());

  const id = await prisma.$transaction(async (tx) => {
    const exchangeNo = await nextNo(tx, ctx.businessId!, branchId, 'EXCHANGE');
    const inline = await syncInlineUdhar(tx, ctx, null, body.udhar, { branchId, partyId: body.partyId, txnDate }, `Exchange #${exchangeNo}`); // TRD-02
    const ex = await tx.exchange.create({ data: { businessId: ctx.businessId!, branchId, exchangeNo, txnDate, createdById: ctx.userId, ...docData(body, p), ...inline } });
    const pools = await poolGuard(tx, branchId, [{ metal: body.metal, form: 'KACHA' }]); // a SELL can't sell more kacha than the pool holds
    if (p.plan.rows) await savePayments(tx, ctx, 'EXCHANGE', ex.id, p.plan);
    await post(tx, ctx, { id: ex.id, exchangeNo, branchId, txnDate }, body, p);
    await pools();
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
  if (!(await scopedDb(ctx).exchange.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  const p = await prepare(ctx, body);
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    // G5 lock order: the exchange row first — a concurrent edit / delete / melt of it waits, so its rows are reversed once
    await lockDoc(tx, 'Exchange', id, ctx.businessId!);
    const old = await tx.exchange.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { id: 'asc' } } } });
    await assertNotProcessed(tx, ctx, id, 'This exchange was sent to melt / refine; revert that processing before editing');
    const txnDate = ledger.businessDate(body.txnDate ?? old.txnDate);
    const before = snap({ ...old, payments: await loadPayments(ctx, 'EXCHANGE', id) });
    const pools = await poolGuard(tx, old.branchId, [{ metal: old.metal, form: 'KACHA' }, { metal: body.metal, form: 'KACHA' }]);
    await ledger.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    const inline = await syncInlineUdhar(tx, ctx, old.inlineUdhar, body.udhar, { branchId: old.branchId, partyId: body.partyId, txnDate }, `Exchange #${old.exchangeNo}`); // TRD-02
    await tx.exchangeLine.deleteMany({ where: { exchangeId: id } });
    const after = await tx.exchange.update({ where: { id }, data: { txnDate, ...docData(body, p), ...inline }, include: { lines: { orderBy: { id: 'asc' } } } });
    await savePayments(tx, ctx, 'EXCHANGE', id, p.plan);
    await post(tx, ctx, { id, exchangeNo: old.exchangeNo, branchId: old.branchId, txnDate }, body, p);
    await pools();
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'EDITED', entity: 'EXCHANGE', entityId: String(id), summary: `Edited exchange #${old.exchangeNo}`, partyName: p.party.name, meta: { before, after: snap({ ...after, payments: p.plan.rows ?? [] }) } });
  });
  return getExchange(ctx, id);
}

/** 409 while any non-reverted kacha process links this exchange (checked inside the tx, after the exchange row lock). */
async function assertNotProcessed(tx: Prisma.TransactionClient, ctx: TenantContext, id: number, message: string): Promise<void> {
  const n = await tx.kachaProcess.count({ where: { businessId: ctx.businessId!, reverted: false, OR: [{ exchangeId: id }, { exchangeIds: { has: id } }] } });
  if (n > 0) throw new HttpError(409, 'CONFLICT', message);
}

export async function deleteExchange(ctx: TenantContext, id: number): Promise<void> {
  if (!(await scopedDb(ctx).exchange.findFirst({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'NOT_FOUND', 'Exchange not found');
  const lctx = lctxOf(ctx);
  await prisma.$transaction(async (tx) => {
    await lockDoc(tx, 'Exchange', id, ctx.businessId!);
    const ex = await tx.exchange.findUniqueOrThrow({ where: { id } });
    await assertNotProcessed(tx, ctx, id, 'Revert the linked kacha processing first');
    // A BUY added kacha to the pool; reversing removes it — 409 if that metal has since been melted away.
    const pools = await poolGuard(tx, ex.branchId, [{ metal: ex.metal, form: 'KACHA' }]);
    await ledger.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await udhar.reverse(tx, lctx, { source: 'EXCHANGE', sourceId: String(id) });
    await syncInlineUdhar(tx, ctx, ex.inlineUdhar, undefined, { branchId: ex.branchId, partyId: ex.partyId, txnDate: ex.txnDate }, ''); // TRD-02
    await pools();
    await tx.exchange.delete({ where: { id } }); // cascades lines
    await savePayments(tx, ctx, 'EXCHANGE', id, null);
    await logActivity(tx, ctx, { module: 'EXCHANGE', action: 'DELETED', entity: 'EXCHANGE', entityId: String(id), summary: `Deleted exchange #${ex.exchangeNo}` });
  });
}

// ───────────── DTO + list/get ─────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toDto(ctx: TenantContext, ex: any): Promise<ExchangeDto> {
  const [refs, payments, procs, udharDto] = await Promise.all([loadRefs(ctx, ex), loadPayments(ctx, 'EXCHANGE', ex.id), scopedDb(ctx).kachaProcess.count({ where: { reverted: false, OR: [{ exchangeId: ex.id }, { exchangeIds: { has: ex.id } }] } }), inlineUdharDto(ctx, ex.inlineUdhar)]);
  const bal = D(ex.finalAmount).minus(ex.cash).minus(ex.online);
  return {
    id: ex.id, exchangeNo: ex.exchangeNo, side: ex.side, party: refs.party, branch: refs.branch, metal: ex.metal, txnDate: dateOnly(ex.txnDate),
    totalFine: wt(ex.totalFine), exactFine: ex.exactFine != null ? wt(ex.exactFine) : null, diffFine: wt(ex.diffFine),
    diff: { pctPlus: String(ex.diffPctPlus), gmPlus: wt(ex.diffGmPlus), pctMinus: String(ex.diffPctMinus), gmMinus: wt(ex.diffGmMinus), plusBy: ex.diffPlusBy, minusBy: ex.diffMinusBy },
    given: ex.givenGross != null ? { gross: wt(ex.givenGross), net: wt(ex.givenNet), touch: String(ex.givenTouch), fine: wt(ex.givenFine) } : null,
    udhar: udharDto,
    afterFine: wt(ex.afterFine), rate: money(ex.rate), charges: money(ex.charges), discount: money(ex.discount),
    roundOff: money(ex.roundOff), finalAmount: money(ex.finalAmount), cash: money(ex.cash), online: money(ex.online), bankAccount: refs.bankAccount,
    balance: money(ex.side === 'BUY' ? bal.negated() : bal), remark: ex.remark,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lines: ex.lines.map((l: any) => ({
      id: l.id, weight: wt(l.weight), touch: String(l.touch), fine: wt(l.fine), serialNo: l.serialNo,
      grossWeight: l.grossWeight != null ? wt(l.grossWeight) : null, lessWeight: l.lessWeight != null ? wt(l.lessWeight) : null,
      meltWeight: l.meltWeight != null ? wt(l.meltWeight) : null, sampleWeight: l.sampleWeight != null ? wt(l.sampleWeight) : null, sampleId: l.sampleId,
    })),
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
