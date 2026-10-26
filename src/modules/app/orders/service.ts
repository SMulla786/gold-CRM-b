import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import type { TenantContext } from '../../../middleware/context';
import { computeLine, RATE_UNIT_GRAMS } from '../../../shared';
import type { OrderDto, OrderItemDto, KarigarIssueDto, BillPaymentInput } from '../../../shared';
import { currentRates, getSettings } from '../service';
import { computePayments, sumAmounts } from '../billing/service';
import { nextTagNo } from '../inventory';
import { filePath, removeFile, replaceFile } from './files';

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const money = (v: unknown) => D(v).toFixed(2);
const wt = (v: unknown) => D(v).toFixed(3);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });

function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch (set X-Branch-Id)');
  return ctx.activeBranchId;
}
const branchScope = (ctx: TenantContext): number[] => (ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds);

/** Atomic per-branch document counter (plain integer series starting at 1). */
async function nextNo(tx: Prisma.TransactionClient, businessId: number, branchId: number, key: string): Promise<number> {
  const r = await tx.$queryRaw<{ next: number }[]>`
    INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${businessId}, ${branchId}, ${key}, 2)
    ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
  return r[0]!.next - 1;
}

// ───────────── Orders ─────────────

type OrderBody = { partyId: number; orderDate?: Date; deliveryDate?: Date; rateType: 'FIXED' | 'ON_DELIVERY'; isUrgent: boolean; remark?: string; items: any[]; payments: BillPaymentInput[]; miscCharges?: number; goldRate?: number; silverRate?: number };

/**
 * TASK-97 extras on top of computeLine: wastageGm is fine grams added to the line fine (and to the metal value only when the
 * sale basis is FINE, the same place wastage % reaches the money); labour is a flat Rs. Both 0 -> the computeLine result unchanged.
 */
export function orderLineExtras(calc: { fine: string; total: string }, x: { wastageGm?: number; labour?: number; rate: number; unitGrams: number; basis: string }): { fine: string; total: string } {
  const wGm = D(x.wastageGm ?? 0);
  const metal = x.basis === 'FINE' && x.unitGrams > 0 ? wGm.times(x.rate).div(x.unitGrams) : D(0);
  return { fine: wt(D(calc.fine).plus(wGm)), total: money(D(calc.total).plus(metal).plus(x.labour ?? 0)) };
}

export async function createOrder(ctx: TenantContext, body: OrderBody): Promise<OrderDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  if (!(await sdb.party.findUnique({ where: { id: body.partyId } }))) throw new HttpError(404, 'NOT_FOUND', 'Party not found');

  const s = await getSettings(ctx);
  const rates = await currentRates(ctx);
  const basis = s['calc.basis'].sale;
  const rateFor = (metal: 'GOLD' | 'SILVER', karatCode?: string | null) => {
    const m = metal === 'GOLD' ? rates.gold : rates.silver;
    const override = metal === 'GOLD' ? body.goldRate : body.silverRate; // TASK-97: one override rate per metal (settings unit)
    const row = m.rows.find((r) => r.karatCode === karatCode) ?? m.rows[0];
    return { rate: override ?? Number(row?.sellRate ?? 0), unitGrams: RATE_UNIT_GRAMS[m.rateUnit] };
  };
  const jtIds = [...new Set(body.items.map((i) => i.jewelleryTypeId).filter((x) => x != null))] as number[];
  if (jtIds.length && (await prisma.jewelleryType.count({ where: { id: { in: jtIds }, OR: [{ businessId: null }, { businessId: ctx.businessId! }] } })) !== jtIds.length) {
    throw new HttpError(404, 'NOT_FOUND', 'Jewellery type not found');
  }

  // resolve item names (tenant) + karat touch
  const nameIds = [...new Set(body.items.map((i) => i.itemNameId))];
  const names = await sdb.itemName.findMany({ where: { id: { in: nameIds } }, include: { group: true } });
  const nameById = new Map(names.map((n) => [n.id, n]));
  const karatCodes = [...new Set(body.items.map((i) => i.karatCode).filter(Boolean))] as string[];
  const karats = karatCodes.length ? await sdb.karatMapping.findMany({ where: { code: { in: karatCodes } } }) : [];
  const touchOf = (metal: string, code?: string | null) => karats.find((k) => k.metal === metal && k.code === code)?.touch;

  const lines = body.items.map((it) => {
    const n = nameById.get(it.itemNameId);
    if (!n) throw new HttpError(404, 'NOT_FOUND', `Item name ${it.itemNameId} not found`);
    if (n.group.stockClass !== it.metal) throw new HttpError(400, 'VALIDATION', `"${n.name}" is a ${n.group.stockClass} item, not ${it.metal}`);
    const touch = it.touch ?? (touchOf(it.metal, it.karatCode) != null ? Number(touchOf(it.metal, it.karatCode)) : 100);
    const { rate, unitGrams } = rateFor(it.metal, it.karatCode);
    const base = computeLine({ gross: it.gross, less: it.less, tunch: touch, wastage: it.wastage, rate, rateUnitGrams: unitGrams, labour: it.making, labourUnit: it.makingUnit, other: it.other, basis });
    const calc = { ...base, ...orderLineExtras(base, { wastageGm: it.wastageGm, labour: it.labour, rate, unitGrams, basis }) };
    return { it, n, touch, calc };
  });
  const estTotal = lines.reduce((a, l) => a.plus(l.calc.total), new Prisma.Decimal(0)).plus(body.miscCharges ?? 0);
  // FIXED: lock the per-unit rate (override, else today's) for each metal present (shortcut: one rate per metal, not per karat)
  const goldRate = body.rateType === 'FIXED' && lines.some((l) => l.it.metal === 'GOLD') ? body.goldRate ?? rates.gold.rows[0]?.sellRate ?? null : null;
  const silverRate = body.rateType === 'FIXED' && lines.some((l) => l.it.metal === 'SILVER') ? body.silverRate ?? rates.silver.rows[0]?.sellRate ?? null : null;

  const orderDate = ledger.businessDate(body.orderDate ?? new Date());
  const lctx = lctxOf(ctx);

  const orderId = await prisma.$transaction(async (tx) => {
    const orderNo = await nextNo(tx, ctx.businessId!, branchId, 'ORDER');
    const order = await tx.order.create({
      data: {
        businessId: ctx.businessId!, branchId, orderNo, partyId: body.partyId, orderDate,
        deliveryDate: body.deliveryDate ? ledger.businessDate(body.deliveryDate) : null, rateType: body.rateType,
        goldRate, silverRate, isUrgent: body.isUrgent, remark: body.remark ?? null, status: 'PENDING', estTotal, advance: 0, createdById: ctx.userId, miscCharges: body.miscCharges ?? 0,
        items: { create: lines.map((l) => ({
          itemNameId: l.n.id, metal: l.it.metal, karatCode: l.it.karatCode ?? null, touch: l.touch, size: l.it.size ?? null, pcs: l.it.pcs,
          gross: l.it.gross, less: l.it.less, net: l.calc.net, wastage: l.it.wastage, fine: l.calc.fine, making: l.it.making, makingUnit: l.it.makingUnit,
          other: l.it.other, estTotal: l.calc.total, remark: l.it.remark ?? null, status: 'PENDING',
          labour: l.it.labour ?? 0, wastageGm: l.it.wastageGm ?? 0, jewelleryTypeId: l.it.jewelleryTypeId ?? null,
        })) },
      },
    });
    const advance = await postAdvances(tx, ctx, order.id, branchId, orderDate, body.payments);
    if (!advance.isZero()) await tx.order.update({ where: { id: order.id }, data: { advance } });
    await logActivity(tx, ctx, { module: 'ORDER', action: 'CREATED', entity: 'Order', entityId: String(order.id), summary: `Order #${orderNo} (${lines.length} item${lines.length === 1 ? '' : 's'})` });
    return order.id;
  });
  return getOrder(ctx, orderId);
}

/** Posts advance payments (OrderPayment + ledger IN + party credit in udhar); returns the money value of advances. */
async function postAdvances(tx: Prisma.TransactionClient, ctx: TenantContext, orderId: number, branchId: number, txnDate: Date, payments: BillPaymentInput[]): Promise<Prisma.Decimal> {
  if (payments.length === 0) return new Prisma.Decimal(0);
  const s = await getSettings(ctx);
  const payCalcs = await computePayments(ctx, payments, s);
  const lctx = lctxOf(ctx);
  const ledRows: ledger.LedgerEntryInput[] = [];
  let partyMoney = new Prisma.Decimal(0), goldFine = new Prisma.Decimal(0), silverFine = new Prisma.Decimal(0);
  for (const pc of payCalcs) {
    const pay = await tx.orderPayment.create({ data: { orderId, mode: pc.input.mode, bankAccountId: pc.bankAccountId ?? null, metal: pc.metal ?? null, metalForm: pc.metalForm ?? null, gross: pc.gross ?? null, net: pc.net ?? null, tunch: pc.tunch ?? null, fine: pc.fine ?? null, rate: pc.rate ?? null, amount: pc.amount, remark: pc.input.remark ?? null, txnDate, isActive: true, createdById: ctx.userId } });
    const base = { branchId, txnDate, direction: 'IN' as const, source: 'ORDER_ADVANCE' as const, sourceId: `${orderId}-P${pay.id}` };
    if (pc.input.mode === 'METAL') {
      ledRows.push({ ...base, asset: pc.metal!, metalForm: pc.metalForm, gross: pc.gross, net: pc.net, fine: pc.fine, amount: pc.amount, narration: 'Order metal advance' });
      if (pc.metal === 'GOLD') goldFine = goldFine.plus(D(pc.fine)); else silverFine = silverFine.plus(D(pc.fine));
    } else {
      ledRows.push({ ...base, asset: 'MONEY', bankAccountId: pc.bankAccountId ?? null, amount: pc.amount, narration: 'Order advance' });
      partyMoney = partyMoney.plus(D(pc.amount));
    }
  }
  await ledger.post(tx, lctx, ledRows);
  // shop now owes the customer until billed → negative party balance
  if (!(partyMoney.isZero() && goldFine.isZero() && silverFine.isZero())) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { partyId: true } });
    await udhar.post(tx, lctx, [{ branchId, partyId: order.partyId, txnDate, amount: partyMoney.negated(), gold: goldFine.negated(), silver: silverFine.negated(), source: 'ORDER_ADVANCE', sourceId: String(orderId), narration: 'Order advance credit' }]);
  }
  return sumAmounts(payCalcs);
}

export async function addOrderAdvance(ctx: TenantContext, id: number, payments: BillPaymentInput[]): Promise<OrderDto> {
  const sdb = scopedDb(ctx);
  const order = await sdb.order.findUnique({ where: { id } });
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  if (order.status === 'DELIVERED' || order.status === 'CANCELLED') throw new HttpError(409, 'CONFLICT', `Cannot add an advance to a ${order.status.toLowerCase()} order`);
  await prisma.$transaction(async (tx) => {
    const added = await postAdvances(tx, ctx, id, order.branchId, ledger.businessDate(), payments);
    await tx.order.update({ where: { id }, data: { advance: D(order.advance).plus(added) } });
    await logActivity(tx, ctx, { module: 'ORDER', action: 'EDITED', entity: 'Order', entityId: String(id), summary: `Advance added to order #${order.orderNo}` });
  });
  return getOrder(ctx, id);
}

export async function cancelOrder(ctx: TenantContext, id: number): Promise<void> {
  const sdb = scopedDb(ctx);
  const order = await sdb.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  if (order.status !== 'PENDING' && order.status !== 'IN_PROCESS') throw new HttpError(409, 'CONFLICT', `A ${order.status.toLowerCase()} order cannot be cancelled`);
  if (order.items.some((it) => it.status === 'ASSIGNED')) throw new HttpError(409, 'CONFLICT', 'Receive or close the open karigar issue before cancelling');
  await prisma.$transaction(async (tx) => {
    // guard on the current cancellable status so two concurrent cancels can't both run
    const claim = await tx.order.updateMany({ where: { id, status: { in: ['PENDING', 'IN_PROCESS'] } }, data: { status: 'CANCELLED' } });
    if (claim.count !== 1) throw new HttpError(409, 'CONFLICT', 'Order is no longer cancellable');
    await logActivity(tx, ctx, { module: 'ORDER', action: 'DELETED', entity: 'Order', entityId: String(id), summary: `Order #${order.orderNo} cancelled` }); // advances stay as the party's credit
  });
}

/**
 * Keyword → a document number ("12" or "#12"), or null when the keyword isn't a plain Int4-safe number
 * (a 10-digit mobile typed in search must never reach an Int column — it's matched via party `contains` instead).
 */
function docNoOf(kw: string): number | null {
  const m = /^#?(\d+)$/.exec(kw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

export async function listOrders(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; status?: string; statuses?: string[]; partyId?: number }): Promise<{ items: OrderDto[]; total: number; page: number; pageSize: number }> {
  const sdb = scopedDb(ctx);
  // keyword: order no / party name / party mobile
  const kw = q.q?.trim();
  let kwWhere = {};
  if (kw) {
    const partyIds = (await sdb.party.findMany({ where: { OR: [{ name: { contains: kw, mode: 'insensitive' } }, { mobile: { contains: kw } }] }, select: { id: true } })).map((p) => p.id);
    const no = docNoOf(kw);
    kwWhere = { OR: [{ partyId: { in: partyIds } }, ...(no != null ? [{ orderNo: no }] : [])] };
  }
  // statuses (any of) narrows further by status when both are given
  const statuses = q.statuses?.length ? (q.status ? q.statuses.filter((x) => x === q.status) : q.statuses) : null;
  const where = { ...(statuses ? { status: { in: statuses as any } } : q.status ? { status: q.status as any } : {}), ...(q.partyId ? { partyId: q.partyId } : {}), ...kwWhere };
  const [rows, total] = await Promise.all([
    sdb.order.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    sdb.order.count({ where }),
  ]);
  return { items: await buildOrders(ctx, rows.map((r) => r.id)), total, page: q.page, pageSize: q.pageSize };
}

export async function getOrder(ctx: TenantContext, id: number): Promise<OrderDto> {
  const [dto] = await buildOrders(ctx, [id]);
  if (!dto) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  return dto;
}

// ───────────── Karigar issue / receive ─────────────

type KarigarIssueBody = { karigarId: number; orderItemIds: number[]; dueDate?: Date; goldFine: number; silverFine: number; cash: number; online: number; bankAccountId?: number; remark?: string; wastagePercent?: number; wastageGm?: number };

export async function createKarigarIssue(ctx: TenantContext, body: KarigarIssueBody): Promise<KarigarIssueDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const karigar = await sdb.party.findUnique({ where: { id: body.karigarId } });
  if (!karigar) throw new HttpError(404, 'NOT_FOUND', 'Karigar not found');
  if (karigar.type !== 'KARIGAR') throw new HttpError(400, 'VALIDATION', 'That party is not a karigar');
  if (body.bankAccountId != null && !(await sdb.bankAccount.findUnique({ where: { id: body.bankAccountId } }))) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');

  // items must be PENDING and belong to this branch's orders
  const items = await prisma.orderItem.findMany({ where: { id: { in: body.orderItemIds }, order: { businessId: ctx.businessId!, branchId } }, include: { order: true } });
  if (items.length !== new Set(body.orderItemIds).size) throw new HttpError(409, 'CONFLICT', 'Some order items are not in this branch');
  if (items.some((it) => it.status !== 'PENDING')) throw new HttpError(409, 'CONFLICT', 'Some items are already assigned or received');

  const issueDate = ledger.businessDate();
  const lctx = lctxOf(ctx);
  const issueId = await prisma.$transaction(async (tx) => {
    const issueNo = await nextNo(tx, ctx.businessId!, branchId, 'KARIGAR_ISSUE');
    const issue = await tx.karigarIssue.create({ data: { businessId: ctx.businessId!, branchId, issueNo, karigarId: body.karigarId, issueDate, dueDate: body.dueDate ? ledger.businessDate(body.dueDate) : null, goldFine: body.goldFine, silverFine: body.silverFine, cash: body.cash, online: body.online, bankAccountId: body.bankAccountId ?? null, remark: body.remark ?? null, status: 'OPEN', createdById: ctx.userId, wastagePercent: body.wastagePercent ?? null, wastageGm: body.wastageGm ?? null } });
    // claim the items atomically on their PENDING status — a concurrent issue can't grab the same item twice
    const claim = await tx.orderItem.updateMany({ where: { id: { in: body.orderItemIds }, status: 'PENDING' }, data: { status: 'ASSIGNED', karigarIssueId: issue.id } });
    if (claim.count !== new Set(body.orderItemIds).size) throw new HttpError(409, 'CONFLICT', 'Some items were just assigned to another issue');
    await tx.order.updateMany({ where: { id: { in: [...new Set(items.map((i) => i.orderId))] }, status: 'PENDING' }, data: { status: 'IN_PROCESS' } });

    const ledRows: ledger.LedgerEntryInput[] = [];
    const sourceId = String(issue.id);
    if (body.goldFine > 0) ledRows.push({ branchId, txnDate: issueDate, asset: 'GOLD', direction: 'OUT', metalForm: 'BULLION', gross: body.goldFine, net: body.goldFine, fine: body.goldFine, source: 'KARIGAR_ISSUE', sourceId, narration: 'Karigar gold issue' });
    if (body.silverFine > 0) ledRows.push({ branchId, txnDate: issueDate, asset: 'SILVER', direction: 'OUT', metalForm: 'BULLION', gross: body.silverFine, net: body.silverFine, fine: body.silverFine, source: 'KARIGAR_ISSUE', sourceId, narration: 'Karigar silver issue' });
    if (body.cash > 0) ledRows.push({ branchId, txnDate: issueDate, asset: 'MONEY', direction: 'OUT', amount: body.cash, source: 'KARIGAR_ISSUE', sourceId, narration: 'Karigar cash issue' });
    if (body.online > 0) ledRows.push({ branchId, txnDate: issueDate, asset: 'MONEY', direction: 'OUT', bankAccountId: body.bankAccountId ?? null, amount: body.online, source: 'KARIGAR_ISSUE', sourceId, narration: 'Karigar online issue' });
    if (ledRows.length) await ledger.post(tx, lctx, ledRows);
    // karigar now owes the shop the material + money handed over
    const amount = D(body.cash).plus(body.online);
    if (!(amount.isZero() && body.goldFine === 0 && body.silverFine === 0)) {
      await udhar.post(tx, lctx, [{ branchId, partyId: body.karigarId, txnDate: issueDate, amount, gold: body.goldFine, silver: body.silverFine, source: 'KARIGAR_ISSUE', sourceId, narration: `Karigar issue #${issueNo}` }]);
    }
    await logActivity(tx, ctx, { module: 'ORDER', action: 'CREATED', entity: 'KarigarIssue', entityId: String(issue.id), summary: `Karigar issue #${issueNo} (${items.length} item${items.length === 1 ? '' : 's'})` });
    return issue.id;
  });
  return getKarigarIssue(ctx, issueId);
}

type KarigarReceiveBody = { items: Array<{ orderItemId: number; returnedGross: number; returnedLess: number; touch?: number; ghatAllowance: number; labour: number; tagNo?: string }> };

export async function receiveKarigar(ctx: TenantContext, issueId: number, body: KarigarReceiveBody): Promise<KarigarIssueDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const issue = await sdb.karigarIssue.findUnique({ where: { id: issueId } });
  if (!issue) throw new HttpError(404, 'NOT_FOUND', 'Karigar issue not found');
  if (issue.status !== 'OPEN') throw new HttpError(409, 'CONFLICT', 'This issue is already closed');

  const ids = body.items.map((i) => i.orderItemId);
  const orderItems = await prisma.orderItem.findMany({ where: { id: { in: ids }, karigarIssueId: issueId, status: 'ASSIGNED', order: { businessId: ctx.businessId! } }, include: { order: true } });
  if (orderItems.length !== new Set(ids).size) throw new HttpError(409, 'CONFLICT', 'Some items do not belong to this open issue');
  const oiById = new Map(orderItems.map((oi) => [oi.id, oi]));
  const names = await sdb.itemName.findMany({ where: { id: { in: [...new Set(orderItems.map((oi) => oi.itemNameId))] } }, include: { group: true } });
  const nameById = new Map(names.map((n) => [n.id, n]));

  const lctx = lctxOf(ctx);
  const txnDate = ledger.businessDate();
  await prisma.$transaction(async (tx) => {
    // claim the items atomically on their ASSIGNED status BEFORE creating any stock — two concurrent receives
    // can't both pass, so a finished piece is never created twice (BUG-10).
    const claim = await tx.orderItem.updateMany({ where: { id: { in: ids }, karigarIssueId: issueId, status: 'ASSIGNED' }, data: { status: 'RECEIVED' } });
    if (claim.count !== new Set(ids).size) throw new HttpError(409, 'CONFLICT', 'Some items were just received');
    let goldBack = new Prisma.Decimal(0), silverBack = new Prisma.Decimal(0), labourTotal = new Prisma.Decimal(0);
    for (const row of body.items) {
      const oi = oiById.get(row.orderItemId)!;
      const n = nameById.get(oi.itemNameId)!;
      const touch = row.touch ?? Number(oi.touch);
      const calc = computeLine({ gross: row.returnedGross, less: row.returnedLess, tunch: touch, wastage: 0 });
      const stockClass = oi.metal; // GOLD/SILVER
      const tagNo = row.tagNo ?? (n.tagPrefix && n.tagDigits ? await nextTagNo(tx, ctx.businessId!, n.tagPrefix, n.tagDigits) : null);
      if (!tagNo) throw new HttpError(400, 'VALIDATION', `"${n.name}" has no tag prefix/digits — pass a tagNo for the finished piece`);
      const piece = await tx.stockItem.create({
        data: {
          businessId: ctx.businessId!, branchId, stockClass, groupId: n.groupId, itemNameId: n.id, method: 'TAG', tagNo, karatCode: oi.karatCode,
          pcs: oi.pcs, gross: row.returnedGross, less: row.returnedLess, net: calc.net, tunch: touch, wastage: 0, fine: calc.fine,
          stoneCharge: 0, labour: row.labour, labourUnit: 'PER_GRAM', other: 0, rate: null, purchaseCost: row.labour,
          status: 'RESERVED', source: 'ORDER_RECEIVE', sourceId: String(oi.orderId), createdById: ctx.userId,
        },
      });
      await ledger.post(tx, lctx, [{ branchId, txnDate, asset: ledger.assetForStockClass(stockClass), direction: 'IN', karatCode: oi.karatCode, pcs: oi.pcs, gross: row.returnedGross, net: calc.net, fine: calc.fine, amount: row.labour, source: 'ORDER_RECEIVE', sourceId: String(oi.orderId), stockItemId: piece.id, narration: `Order receive (order #${oi.order.orderNo})` }]);
      await tx.orderItem.update({ where: { id: oi.id }, data: { status: 'RECEIVED', returnedGross: row.returnedGross, returnedNet: calc.net, returnedFine: calc.fine, ghatAllowance: row.ghatAllowance, karigarLabour: row.labour, stockItemId: piece.id, receivedAt: new Date() } });
      const back = D(calc.fine).plus(row.ghatAllowance);
      if (oi.metal === 'GOLD') goldBack = goldBack.plus(back); else silverBack = silverBack.plus(back);
      labourTotal = labourTotal.plus(row.labour);
    }
    // karigar returns metal (+ ghat allowance) and the shop owes labour → reduces what the karigar owes
    if (!(goldBack.isZero() && silverBack.isZero() && labourTotal.isZero())) {
      await udhar.post(tx, lctx, [{ branchId, partyId: issue.karigarId, txnDate, amount: labourTotal.negated(), gold: goldBack.negated(), silver: silverBack.negated(), source: 'ORDER_RECEIVE', sourceId: String(issueId), narration: `Karigar receive (issue #${issue.issueNo})` }]);
    }

    // close the issue if every one of its items is received; mark orders READY when all their items are received
    const remaining = await tx.orderItem.count({ where: { karigarIssueId: issueId, status: { not: 'RECEIVED' } } });
    if (remaining === 0) await tx.karigarIssue.update({ where: { id: issueId }, data: { status: 'RECEIVED' } });
    for (const orderId of [...new Set(orderItems.map((oi) => oi.orderId))]) {
      const left = await tx.orderItem.count({ where: { orderId, status: { not: 'RECEIVED' } } });
      if (left === 0) await tx.order.update({ where: { id: orderId }, data: { status: 'READY' } });
    }
    await logActivity(tx, ctx, { module: 'ORDER', action: 'EDITED', entity: 'KarigarIssue', entityId: String(issueId), summary: `Received ${body.items.length} item${body.items.length === 1 ? '' : 's'} on issue #${issue.issueNo}` });
  });
  return getKarigarIssue(ctx, issueId);
}

export async function listKarigarIssues(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; karigarId?: number; status?: string }): Promise<{ items: KarigarIssueDto[]; total: number; page: number; pageSize: number }> {
  const sdb = scopedDb(ctx);
  // keyword: karigar name / issue no / order no / item name
  const kw = q.q?.trim();
  let kwWhere = {};
  if (kw) {
    const no = docNoOf(kw);
    const [karigars, itemNames] = await Promise.all([
      sdb.party.findMany({ where: { name: { contains: kw, mode: 'insensitive' } }, select: { id: true } }),
      sdb.itemName.findMany({ where: { name: { contains: kw, mode: 'insensitive' } }, select: { id: true } }),
    ]);
    const itemOr = [
      ...(itemNames.length ? [{ itemNameId: { in: itemNames.map((n) => n.id) } }] : []),
      ...(no != null ? [{ order: { orderNo: no } }] : []),
    ];
    const issueIds = itemOr.length
      ? (await prisma.orderItem.findMany({ where: { karigarIssueId: { not: null }, order: { businessId: ctx.businessId! }, OR: itemOr }, select: { karigarIssueId: true }, distinct: ['karigarIssueId'] }))
          .map((r) => r.karigarIssueId).filter((x): x is number => x != null)
      : [];
    kwWhere = { OR: [{ karigarId: { in: karigars.map((p) => p.id) } }, { id: { in: issueIds } }, ...(no != null ? [{ issueNo: no }] : [])] };
  }
  const where = { ...(q.karigarId ? { karigarId: q.karigarId } : {}), ...(q.status ? { status: q.status as any } : {}), ...kwWhere };
  const [rows, total] = await Promise.all([
    sdb.karigarIssue.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
    sdb.karigarIssue.count({ where }),
  ]);
  return { items: await Promise.all(rows.map((r) => getKarigarIssue(ctx, r.id))), total, page: q.page, pageSize: q.pageSize };
}

export async function getKarigarIssue(ctx: TenantContext, id: number): Promise<KarigarIssueDto> {
  const sdb = scopedDb(ctx);
  const issue = await sdb.karigarIssue.findUnique({ where: { id } });
  if (!issue) throw new HttpError(404, 'NOT_FOUND', 'Karigar issue not found');
  const [karigar, bank, items] = await Promise.all([
    sdb.party.findUnique({ where: { id: issue.karigarId }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }),
    issue.bankAccountId != null ? sdb.bankAccount.findUnique({ where: { id: issue.bankAccountId }, select: { id: true, bankName: true } }) : null,
    prisma.orderItem.findMany({ where: { karigarIssueId: id, order: { businessId: ctx.businessId! } }, include: { order: true } }),
  ]);
  const nameMap = await itemNameMap(ctx, items.map((i) => i.itemNameId));
  const orderParties = await sdb.party.findMany({ where: { id: { in: [...new Set(items.map((it) => it.order.partyId))] } }, select: { id: true, name: true, type: true, mobile: true, shopName: true } });
  const orderPartyMap = new Map(orderParties.map((p) => [p.id, p]));
  return {
    id: issue.id, issueNo: issue.issueNo, issueDate: issue.issueDate.toISOString().slice(0, 10), dueDate: issue.dueDate?.toISOString().slice(0, 10) ?? null,
    karigar: karigar as any, goldFine: wt(issue.goldFine), silverFine: wt(issue.silverFine), cash: money(issue.cash), online: money(issue.online),
    bankAccount: bank ? { id: bank.id, name: bank.bankName } : null, remark: issue.remark, status: issue.status as any,
    wastagePercent: issue.wastagePercent != null ? wt(issue.wastagePercent) : null, wastageGm: issue.wastageGm != null ? wt(issue.wastageGm) : null,
    items: items.map((it) => ({ ...orderItemDto(it, nameMap, null), order: { id: it.order.id, orderNo: it.order.orderNo, party: orderPartyMap.get(it.order.partyId) as any } })),
    createdAt: issue.createdAt.toISOString(),
  };
}

// ───────────── builders ─────────────

async function itemNameMap(ctx: TenantContext, ids: number[]): Promise<Map<number, string>> {
  const u = [...new Set(ids)];
  const names = u.length ? await scopedDb(ctx).itemName.findMany({ where: { id: { in: u } }, select: { id: true, name: true } }) : [];
  return new Map(names.map((n) => [n.id, n.name]));
}

function orderItemDto(it: any, nameMap: Map<number, string>, issueRef: OrderItemDto['karigarIssue']): OrderItemDto {
  return {
    id: it.id, itemName: { id: it.itemNameId, name: nameMap.get(it.itemNameId) ?? '' }, metal: it.metal, karatCode: it.karatCode, touch: wt(it.touch),
    size: it.size, pcs: it.pcs, gross: wt(it.gross), less: wt(it.less), net: wt(it.net), wastage: wt(it.wastage), fine: wt(it.fine),
    making: money(it.making), makingUnit: it.makingUnit, other: money(it.other), estTotal: money(it.estTotal), remark: it.remark, status: it.status,
    karigarIssue: issueRef, stockItemId: it.stockItemId, returnedGross: it.returnedGross != null ? wt(it.returnedGross) : null,
    returnedNet: it.returnedNet != null ? wt(it.returnedNet) : null, returnedFine: it.returnedFine != null ? wt(it.returnedFine) : null,
    ghatAllowance: it.ghatAllowance != null ? wt(it.ghatAllowance) : null, karigarLabour: it.karigarLabour != null ? money(it.karigarLabour) : null,
    labour: money(it.labour), wastageGm: wt(it.wastageGm), jewelleryTypeId: it.jewelleryTypeId ?? null,
  };
}

async function buildOrders(ctx: TenantContext, ids: number[]): Promise<OrderDto[]> {
  if (ids.length === 0) return [];
  const sdb = scopedDb(ctx);
  const orders = await sdb.order.findMany({ where: { id: { in: ids } }, include: { items: true, payments: { where: { isActive: true } } } });
  if (orders.length === 0) return [];
  const nameMap = await itemNameMap(ctx, orders.flatMap((o) => o.items.map((i) => i.itemNameId)));
  const partyIds = [...new Set(orders.map((o) => o.partyId))];
  const branchIds = [...new Set(orders.map((o) => o.branchId))];
  const issueIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.karigarIssueId).filter((x): x is number => x != null)))];
  const userIds = [...new Set(orders.map((o) => o.createdById).filter((x): x is number => x != null))];
  const [parties, branches, issues, users] = await Promise.all([
    sdb.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true, type: true, mobile: true, shopName: true } }),
    sdb.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }),
    issueIds.length ? sdb.karigarIssue.findMany({ where: { id: { in: issueIds } }, select: { id: true, issueNo: true, karigarId: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
  ]);
  const karigarMap = await itemNameMapParties(ctx, issues.map((i) => i.karigarId));
  const partyMap = new Map(parties.map((p) => [p.id, p]));
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));
  const issueMap = new Map(issues.map((i) => [i.id, i]));
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  const byId = new Map(orders.map((o) => [o.id, o]));
  return ids.map((id) => byId.get(id)).filter((o): o is NonNullable<typeof o> => !!o).map((o) => ({
    id: o.id, orderNo: o.orderNo, orderDate: o.orderDate.toISOString().slice(0, 10), deliveryDate: o.deliveryDate?.toISOString().slice(0, 10) ?? null,
    party: partyMap.get(o.partyId) as any, branch: { id: o.branchId, name: branchMap.get(o.branchId) ?? '' }, rateType: o.rateType,
    goldRate: o.goldRate != null ? money(o.goldRate) : null, silverRate: o.silverRate != null ? money(o.silverRate) : null, isUrgent: o.isUrgent,
    remark: o.remark, status: o.status, estTotal: money(o.estTotal), advance: money(o.advance), billId: o.billId,
    miscCharges: money(o.miscCharges), designUrl: o.designUrl,
    items: o.items.map((it) => orderItemDto(it, nameMap, it.karigarIssueId != null && issueMap.has(it.karigarIssueId)
      ? { id: it.karigarIssueId, issueNo: issueMap.get(it.karigarIssueId)!.issueNo, karigar: { id: issueMap.get(it.karigarIssueId)!.karigarId, name: karigarMap.get(issueMap.get(it.karigarIssueId)!.karigarId) ?? '' } }
      : null)),
    payments: o.payments.map(paymentDto),
    createdBy: o.createdById != null ? (userMap.get(o.createdById) ?? null) : null, createdAt: o.createdAt.toISOString(),
  }));
}

async function itemNameMapParties(ctx: TenantContext, ids: number[]): Promise<Map<number, string>> {
  const u = [...new Set(ids)];
  const p = u.length ? await scopedDb(ctx).party.findMany({ where: { id: { in: u } }, select: { id: true, name: true } }) : [];
  return new Map(p.map((x) => [x.id, x.name]));
}

function paymentDto(p: any) {
  return { id: p.id, mode: p.mode, bankAccountId: p.bankAccountId, metal: p.metal, metalForm: p.metalForm, gross: p.gross != null ? wt(p.gross) : null, net: p.net != null ? wt(p.net) : null, tunch: p.tunch != null ? wt(p.tunch) : null, fine: p.fine != null ? wt(p.fine) : null, rate: p.rate != null ? money(p.rate) : null, amount: money(p.amount), remark: p.remark, txnDate: p.txnDate.toISOString().slice(0, 10), isActive: p.isActive } as any;
}

// ───────────── Design file (TASK-97) ─────────────

export async function saveOrderDesign(ctx: TenantContext, id: number, buffer: Buffer): Promise<void> {
  const order = await scopedDb(ctx).order.findUnique({ where: { id }, select: { designUrl: true } });
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  await replaceFile(ctx, 'orders', buffer, order.designUrl, (rel) => scopedDb(ctx).order.update({ where: { id }, data: { designUrl: rel } }), true);
}

export async function orderDesignPath(ctx: TenantContext, id: number): Promise<string> {
  return filePath((await scopedDb(ctx).order.findUnique({ where: { id }, select: { designUrl: true } }))?.designUrl);
}

export async function removeOrderDesign(ctx: TenantContext, id: number): Promise<void> {
  const order = await scopedDb(ctx).order.findUnique({ where: { id }, select: { designUrl: true } });
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
  if (!order.designUrl) return;
  await scopedDb(ctx).order.update({ where: { id }, data: { designUrl: null } });
  await removeFile(order.designUrl);
}
