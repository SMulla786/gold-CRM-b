import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { scopedDb } from '../../../lib/db';
import * as ledger from '../../../lib/ledger';
import * as udhar from '../../../lib/udhar';
import { logActivity } from '../../../lib/activity';
import { HttpError } from '../../../middleware/error';
import { computeBill, computeLine, fineWeight, metalToMoney, moneyToMetal, netWeight, PAN_CASH_LIMIT, RATE_UNIT_GRAMS } from '../../../shared';
import type { BillBody, BillDto, BillKind, BillLineDto, BillListItemDto, BillPaymentDto, BillPaymentInput, BillType, LedgerSource, Paged, PartyRefDto, StockClass } from '../../../shared';
import type { TenantContext } from '../../../middleware/context';
import { getSettings } from '../service';
import { nextTagNo } from '../inventory';
import { docKey, formatBillNo, seriesStart } from './numbering';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Settings = Awaited<ReturnType<typeof getSettings>>;
const D = (v: unknown) => new Prisma.Decimal((v as Prisma.Decimal.Value) ?? 0);
const lctxOf = (ctx: TenantContext) => ({ businessId: ctx.businessId!, branchIds: ctx.branchIds, userId: ctx.userId });
const billSource = (kind: BillKind): LedgerSource => (kind === 'SELL' ? 'SELL_BILL' : 'PURCHASE_BILL');

/** A bill belongs to exactly one branch — admins must pick one via X-Branch-Id (not "all"). */
function activeBranch(ctx: TenantContext): number {
  if (ctx.activeBranchId == null) throw new HttpError(400, 'VALIDATION', 'Select one branch for the bill (set X-Branch-Id)');
  return ctx.activeBranchId;
}

/** Rate unit (grams) for a line: SELL metals use the shop's rate unit; everything else is per gram. */
const rateUnitGrams = (cls: StockClass, kind: BillKind, s: Settings): number =>
  kind === 'PURCHASE' ? 1 : cls === 'GOLD' ? RATE_UNIT_GRAMS[s['rates.units'].gold] : cls === 'SILVER' ? RATE_UNIT_GRAMS[s['rates.units'].silver] : 1;
const metalUnitGrams = (metal: 'GOLD' | 'SILVER', s: Settings): number => RATE_UNIT_GRAMS[metal === 'GOLD' ? s['rates.units'].gold : s['rates.units'].silver];

// ───────────── Payments (shared by create + add-payments) ─────────────

interface PayCalc {
  input: BillPaymentInput;
  amount: string;
  bankAccountId?: number;
  metal?: 'GOLD' | 'SILVER';
  metalForm?: 'BULLION' | 'KACHA';
  gross?: number;
  net?: string;
  fine?: string;
  tunch?: number;
  rate?: number;
}

async function computePayments(ctx: TenantContext, payments: BillPaymentInput[], s: Settings): Promise<PayCalc[]> {
  const bankIds = [...new Set(payments.flatMap((p) => (p.mode === 'ONLINE' ? [p.bankAccountId] : [])))];
  if (bankIds.length) {
    const have = new Set((await scopedDb(ctx).bankAccount.findMany({ where: { id: { in: bankIds } }, select: { id: true } })).map((b) => b.id));
    for (const id of bankIds) if (!have.has(id)) throw new HttpError(404, 'NOT_FOUND', 'Bank account not found');
  }
  return payments.map((p): PayCalc => {
    if (p.mode === 'CASH') return { input: p, amount: String(p.amount) };
    if (p.mode === 'ONLINE') return { input: p, amount: String(p.amount), bankAccountId: p.bankAccountId };
    const net = netWeight(p.gross, p.less);
    const fine = fineWeight(net, p.tunch, 0); // payments: no wastage
    return { input: p, amount: metalToMoney(fine, p.rate, metalUnitGrams(p.metal, s)), metal: p.metal, metalForm: p.metalForm, gross: p.gross, net: net.toFixed(3), fine: fine.toFixed(3), tunch: p.tunch, rate: p.rate };
  });
}

/** One ledger row per payment (CASH/ONLINE → MONEY, METAL → GOLD/SILVER). SELL = money/metal IN, PURCHASE = OUT. */
function paymentLedgerRow(pc: PayCalc, paymentId: number, billId: number, kind: BillKind, branchId: number, txnDate: Date): ledger.LedgerEntryInput {
  const direction = kind === 'SELL' ? 'IN' : 'OUT';
  const base = { branchId, txnDate, direction, source: billSource(kind), sourceId: `${billId}-P${paymentId}` } as const;
  if (pc.input.mode === 'METAL') return { ...base, asset: pc.metal!, metalForm: pc.metalForm, gross: pc.gross, net: pc.net, fine: pc.fine, amount: pc.amount, narration: 'Bill metal payment' };
  return { ...base, asset: 'MONEY', bankAccountId: pc.bankAccountId ?? null, amount: pc.amount, narration: 'Bill payment' };
}

const sumAmounts = (pcs: PayCalc[]) => pcs.reduce((a, pc) => a.plus(D(pc.amount)), new Prisma.Decimal(0));

// ───────────── Line resolution ─────────────

interface ResolvedLine {
  input: BillBody['items'][number];
  action: 'SELL_TAG' | 'SELL_LOOSE' | 'SELL_DIRECT' | 'PURCHASE';
  stockClass: StockClass;
  description: string;
  hsnCode: string | null;
  tagNo: string | null;
  karatCode: string | null;
  groupId: number | null;
  itemNameId: number | null;
  pcs: number;
  gross: number;
  less: number;
  tunch: number;
  wastage: number;
  calc: ReturnType<typeof computeLine>;
  stockItem?: any;
  itemName?: any;
}

async function resolveLines(ctx: TenantContext, body: BillBody, branchId: number, s: Settings): Promise<ResolvedLine[]> {
  const sdb = scopedDb(ctx);
  const sellStockIds = body.kind === 'SELL' ? [...new Set(body.items.flatMap((l) => (l.stockItemId != null ? [l.stockItemId] : [])))] : [];
  const nameIds = [...new Set(body.items.flatMap((l) => (l.stockItemId == null && l.itemNameId != null ? [l.itemNameId] : [])))];
  const [stockItems, itemNames, karats] = await Promise.all([
    sellStockIds.length ? sdb.stockItem.findMany({ where: { id: { in: sellStockIds }, status: 'AVAILABLE', branchId }, include: { itemName: true, group: true } }) : [],
    nameIds.length ? sdb.itemName.findMany({ where: { id: { in: nameIds } }, include: { group: true } }) : [],
    sdb.karatMapping.findMany({ select: { code: true, touch: true } }),
  ]);
  const stockById = new Map(stockItems.map((i) => [i.id, i]));
  const nameById = new Map(itemNames.map((n) => [n.id, n]));
  const touch = new Map(karats.map((k) => [k.code, Number(k.touch)]));
  const hsnIds = [...new Set([...stockItems.flatMap((i) => [i.itemName.hsnId, i.group.hsnId]), ...itemNames.flatMap((n) => [n.hsnId, n.group.hsnId])].filter((x): x is number => x != null))];
  const hsn = new Map((hsnIds.length ? await prisma.hsnCode.findMany({ where: { id: { in: hsnIds } }, select: { id: true, code: true } }) : []).map((h) => [h.id, h.code]));

  return body.items.map((line): ResolvedLine => {
    const basis = body.kind === 'SELL' ? s['calc.basis'].sale : s['calc.basis'].purchase;
    let r: Omit<ResolvedLine, 'calc'>;
    if (body.kind === 'SELL' && line.stockItemId != null) {
      const item = stockById.get(line.stockItemId);
      if (!item) throw new HttpError(409, 'CONFLICT', `Stock item ${line.stockItemId} is not AVAILABLE in this branch`);
      const cls = item.stockClass as StockClass;
      const hsnCode = (item.itemName.hsnId != null ? hsn.get(item.itemName.hsnId) : item.group.hsnId != null ? hsn.get(item.group.hsnId) : null) ?? null;
      const common = { stockClass: cls, description: item.itemName.name, hsnCode, tagNo: item.tagNo, karatCode: item.karatCode, groupId: item.groupId, itemNameId: item.itemNameId, tunch: Number(item.tunch), wastage: Number(item.wastage), stockItem: item };
      if (item.method === 'TAG') r = { input: line, action: 'SELL_TAG', pcs: item.pcs, gross: Number(item.gross), less: Number(item.less), ...common };
      else {
        if (line.gross > Number(item.gross) || line.less > Number(item.less) || line.pcs > item.pcs) throw new HttpError(409, 'CONFLICT', `Stock item ${item.id} does not hold that much`);
        r = { input: line, action: 'SELL_LOOSE', pcs: line.pcs, gross: line.gross, less: line.less, ...common };
      }
    } else if (body.kind === 'PURCHASE') {
      if (line.itemNameId == null) throw new HttpError(400, 'VALIDATION', 'Purchase line needs itemNameId');
      const name = nameById.get(line.itemNameId);
      if (!name) throw new HttpError(404, 'NOT_FOUND', 'Item name not found');
      const karatCode = line.karatCode ?? name.defKaratCode ?? null;
      const hsnCode = (name.hsnId != null ? hsn.get(name.hsnId) : name.group.hsnId != null ? hsn.get(name.group.hsnId) : null) ?? null;
      r = { input: line, action: 'PURCHASE', stockClass: name.group.stockClass, description: name.name, hsnCode, tagNo: line.tagNo ?? null, karatCode, groupId: name.groupId, itemNameId: name.id, pcs: line.pcs, gross: line.gross, less: line.less, tunch: line.tunch ?? (karatCode ? touch.get(karatCode) : undefined) ?? (name.defTunch != null ? Number(name.defTunch) : undefined) ?? 100, wastage: line.wastage, itemName: name };
    } else {
      // SELL direct line (no stock movement)
      const name = line.itemNameId != null ? nameById.get(line.itemNameId) : undefined;
      if (line.itemNameId != null && !name) throw new HttpError(404, 'NOT_FOUND', 'Item name not found');
      if (!name && (!line.description || !line.stockClass)) throw new HttpError(400, 'VALIDATION', 'Direct line needs itemNameId or description + stockClass');
      const karatCode = line.karatCode ?? name?.defKaratCode ?? null;
      const hsnCode = name ? ((name.hsnId != null ? hsn.get(name.hsnId) : name.group.hsnId != null ? hsn.get(name.group.hsnId) : null) ?? null) : null;
      r = { input: line, action: 'SELL_DIRECT', stockClass: (name ? name.group.stockClass : line.stockClass!) as StockClass, description: name ? name.name : line.description!, hsnCode, tagNo: line.tagNo ?? null, karatCode, groupId: name?.groupId ?? null, itemNameId: name?.id ?? null, pcs: line.pcs, gross: line.gross, less: line.less, tunch: line.tunch ?? (karatCode ? touch.get(karatCode) : undefined) ?? (name?.defTunch != null ? Number(name.defTunch) : undefined) ?? 100, wastage: line.wastage, itemName: name };
    }
    const calc = computeLine({ pcs: r.pcs, gross: r.gross, less: r.less, tunch: r.tunch, wastage: r.wastage, stoneCharge: line.stoneCharge, rate: line.rate, rateUnitGrams: rateUnitGrams(r.stockClass, body.kind, s), labour: line.labour, labourUnit: line.labourUnit, other: line.other, discount: line.discount, discountUnit: line.discountUnit, basis });
    return { ...r, calc };
  });
}

// ───────────── Create ─────────────

export async function nextBillNo(ctx: TenantContext, q: { kind: BillKind; billType: BillType }): Promise<{ billNo: string }> {
  const branchId = activeBranch(ctx);
  const s = await getSettings(ctx);
  const numbering = s[q.kind === 'SELL' ? 'invoice.sale' : 'invoice.purchase'];
  const date = ledger.businessDate();
  const key = docKey(q.kind, q.billType, numbering, date);
  const row = await prisma.docSequence.findUnique({ where: { businessId_branchId_key: { businessId: ctx.businessId!, branchId, key } } });
  const seq = row ? row.next : seriesStart(q.billType, numbering);
  return { billNo: formatBillNo(seq, q.billType, numbering, date) };
}

export async function createBill(ctx: TenantContext, body: BillBody): Promise<BillDto> {
  const branchId = activeBranch(ctx);
  const sdb = scopedDb(ctx);
  const s = await getSettings(ctx);
  const numbering = s[body.kind === 'SELL' ? 'invoice.sale' : 'invoice.purchase'];

  const party = await sdb.party.findUnique({ where: { id: body.partyId } });
  if (!party) throw new HttpError(404, 'NOT_FOUND', 'Party not found');
  const branch = await sdb.branch.findUnique({ where: { id: branchId }, select: { stateId: true } });
  const business = await prisma.business.findUnique({ where: { id: ctx.businessId! }, select: { stateId: true } });
  const branchState = branch?.stateId ?? business?.stateId ?? null;
  const interState = party.stateId != null && branchState != null && party.stateId !== branchState;

  const lines = await resolveLines(ctx, body, branchId, s);
  const payCalcs = await computePayments(ctx, body.payments, s);
  const paid = sumAmounts(payCalcs);

  // PAN rule (SELL): big cash receipt needs the party's PAN.
  if (body.kind === 'SELL') {
    const cash = payCalcs.filter((p) => p.input.mode === 'CASH').reduce((a, p) => a.plus(D(p.amount)), new Prisma.Decimal(0));
    if (cash.gte(PAN_CASH_LIMIT) && !party.pan && !body.pan) throw new HttpError(400, 'VALIDATION', 'PAN required for this cash amount', { code: 'PAN_REQUIRED' });
  }
  // Rate limits (SELL GOLD/SILVER lines with a rate).
  if (body.kind === 'SELL') {
    const limits = await sdb.rateLimit.findMany({});
    lines.forEach((r, i) => {
      if ((r.stockClass === 'GOLD' || r.stockClass === 'SILVER') && Number(r.input.rate) > 0) {
        const unit = r.stockClass === 'GOLD' ? s['rates.units'].gold : s['rates.units'].silver;
        const lim = limits.find((l) => l.metal === r.stockClass && l.rateUnit === unit);
        if (lim && (D(r.input.rate).lt(lim.minRate) || D(r.input.rate).gt(lim.maxRate))) throw new HttpError(400, 'VALIDATION', 'Rate outside the allowed limit', { code: 'RATE_LIMIT', line: i });
      }
    });
  }

  const gstExempt = numbering.gstOnRemainingMetal ? payCalcs.filter((p) => p.input.mode === 'METAL').reduce((a, p) => a.plus(D(p.amount)), new Prisma.Decimal(0)) : new Prisma.Decimal(0);
  const billCalc = computeBill({ lineTotals: lines.map((r) => r.calc.total), discount: body.discount, discountUnit: body.discountUnit, gstPercent: body.billType === 'ROUGH' ? 0 : body.gstPercent, interState, gstExemptAmount: gstExempt, roundTo: 1 });

  const bal = D(billCalc.final).minus(paid);
  let keepWeight: string | null = null;
  if (bal.gt(0) && body.keepBalanceAs !== 'MONEY') keepWeight = moneyToMetal(bal, body.keepRate!, metalUnitGrams(body.keepBalanceAs, s));

  const billDate = ledger.businessDate(body.billDate ?? new Date());
  const lctx = lctxOf(ctx);

  const billId = await prisma.$transaction(async (tx) => {
    const key = docKey(body.kind, body.billType, numbering, billDate);
    const start = seriesStart(body.billType, numbering);
    const seqRow = await tx.$queryRaw<{ next: number }[]>`
      INSERT INTO "DocSequence" ("businessId","branchId","key","next") VALUES (${ctx.businessId!}, ${branchId}, ${key}, ${start + 1})
      ON CONFLICT ("businessId","branchId","key") DO UPDATE SET "next" = "DocSequence"."next" + 1 RETURNING "next"`;
    const seq = Number(seqRow[0]!.next) - 1;
    const billNo = formatBillNo(seq, body.billType, numbering, billDate);
    if (body.pan && !party.pan) await tx.party.update({ where: { id: party.id }, data: { pan: body.pan } });

    const bill = await tx.bill.create({
      data: {
        businessId: ctx.businessId!, branchId, kind: body.kind, billType: body.billType, billNo, seq, partyId: party.id, billDate,
        dueDate: body.dueDate ? ledger.businessDate(body.dueDate) : null, interState,
        sub: billCalc.sub, discount: body.discount, discountUnit: body.discountUnit, discountAmount: billCalc.discountAmount,
        gstPercent: body.billType === 'ROUGH' ? 0 : body.gstPercent, taxable: billCalc.taxable, cgst: billCalc.cgst, sgst: billCalc.sgst, igst: billCalc.igst,
        total: billCalc.total, round: billCalc.round, final: billCalc.final, paid, keepBalanceAs: body.keepBalanceAs,
        keepRate: body.keepBalanceAs !== 'MONEY' ? (body.keepRate ?? null) : null, keepWeight, remark: body.remark ?? null, status: 'ACTIVE', createdById: ctx.userId,
      },
    });

    const stockLedger: ledger.LedgerEntryInput[] = [];
    for (const r of lines) {
      let stockItemId: number | null = null;
      if (r.action === 'SELL_TAG') {
        await tx.stockItem.update({ where: { id: r.stockItem.id }, data: { status: 'SOLD' } });
        stockItemId = r.stockItem.id;
      } else if (r.action === 'SELL_LOOSE') {
        const it = r.stockItem;
        const g = D(it.gross).minus(r.gross);
        const l = D(it.less).minus(r.less);
        const net = Prisma.Decimal.max(g.minus(l), 0);
        const fine = net.times(D(it.tunch)).div(100).times(D(it.wastage).div(100).plus(1));
        await tx.stockItem.update({ where: { id: it.id }, data: { gross: g, less: l, pcs: it.pcs - r.pcs, net, fine, status: g.lte(0) ? 'SOLD' : 'AVAILABLE' } });
        stockItemId = it.id;
      } else if (r.action === 'PURCHASE') {
        const method = r.input.tagNo || r.itemName.method === 'TAG' ? 'TAG' : 'LOOSE';
        const tagNo = method === 'TAG' ? (r.input.tagNo ?? (r.itemName.tagPrefix && r.itemName.tagDigits ? await nextTagNo(tx, ctx.businessId!, r.itemName.tagPrefix, r.itemName.tagDigits) : null)) : null;
        const created = await tx.stockItem.create({
          data: {
            businessId: ctx.businessId!, branchId, stockClass: r.stockClass, groupId: r.itemName.groupId, itemNameId: r.itemName.id, method, tagNo, huid: null, karatCode: r.karatCode,
            pcs: r.pcs, gross: r.gross, less: r.less, net: r.calc.net, tunch: r.tunch, wastage: r.wastage, fine: r.calc.fine, stoneCharge: r.input.stoneCharge, labour: r.input.labour,
            labourUnit: r.input.labourUnit, other: r.input.other, rate: r.input.rate || null, purchaseCost: r.calc.total, status: 'AVAILABLE', source: 'PURCHASE_BILL', sourceId: String(bill.id), createdById: ctx.userId,
          },
        });
        stockItemId = created.id;
      }
      await tx.billItem.create({
        data: {
          billId: bill.id, stockItemId, itemNameId: r.itemNameId, groupId: r.groupId, stockClass: r.stockClass, description: r.description, hsnCode: r.hsnCode, tagNo: r.tagNo, karatCode: r.karatCode,
          pcs: r.pcs, gross: r.gross, less: r.less, net: r.calc.net, tunch: r.tunch, wastage: r.wastage, fine: r.calc.fine, stoneCharge: r.input.stoneCharge, rate: r.input.rate, labour: r.input.labour,
          labourUnit: r.input.labourUnit, other: r.input.other, discount: r.input.discount, discountUnit: r.input.discountUnit, metalAmount: r.calc.metalAmount, labourAmount: r.calc.labourAmount, total: r.calc.total,
        },
      });
      if (stockItemId != null) {
        stockLedger.push({ branchId, txnDate: billDate, asset: ledger.assetForStockClass(r.stockClass), direction: body.kind === 'SELL' ? 'OUT' : 'IN', karatCode: r.karatCode, pcs: r.pcs, gross: r.gross, net: r.calc.net, fine: r.calc.fine, amount: r.calc.total, source: billSource(body.kind), sourceId: String(bill.id), stockItemId, narration: `${body.kind === 'SELL' ? 'Sold on' : 'Purchased on'} ${billNo}` });
      }
    }
    if (stockLedger.length) await ledger.post(tx, lctx, stockLedger);

    for (const pc of payCalcs) {
      const pay = await tx.billPayment.create({ data: { billId: bill.id, mode: pc.input.mode, bankAccountId: pc.bankAccountId ?? null, metal: pc.metal ?? null, metalForm: pc.metalForm ?? null, gross: pc.gross ?? null, net: pc.net ?? null, tunch: pc.tunch ?? null, fine: pc.fine ?? null, rate: pc.rate ?? null, amount: pc.amount, remark: pc.input.remark ?? null, txnDate: billDate, isActive: true, createdById: ctx.userId } });
      await ledger.post(tx, lctx, [paymentLedgerRow(pc, pay.id, bill.id, body.kind, branchId, billDate)]);
    }

    if (!bal.isZero()) {
      const sign = body.kind === 'SELL' ? 1 : -1;
      const entry: udhar.UdharEntryInput = { branchId, partyId: party.id, txnDate: billDate, source: billSource(body.kind), sourceId: String(bill.id), narration: billNo };
      if (keepWeight != null) {
        if (body.keepBalanceAs === 'GOLD') entry.gold = D(keepWeight).times(sign);
        else entry.silver = D(keepWeight).times(sign);
      } else entry.amount = bal.times(sign);
      await udhar.post(tx, lctx, [entry]);
    }

    await logActivity(tx, ctx, { module: body.kind, action: 'CREATED', entity: 'BILL', entityId: String(bill.id), summary: `${body.kind === 'SELL' ? 'Sell' : 'Purchase'} bill ${billNo} ₹${billCalc.final}`, partyName: party.name });
    return bill.id;
  });

  return getBill(ctx, billId);
}

// ───────────── Add payments ─────────────

export async function addBillPayments(ctx: TenantContext, id: number, body: { payments: BillPaymentInput[]; txnDate?: Date }): Promise<BillDto> {
  const sdb = scopedDb(ctx);
  const bill = await sdb.bill.findFirst({ where: { id } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
  const s = await getSettings(ctx);
  const payCalcs = await computePayments(ctx, body.payments, s);
  const added = sumAmounts(payCalcs);
  const txnDate = ledger.businessDate(body.txnDate ?? new Date());
  const lctx = lctxOf(ctx);

  await prisma.$transaction(async (tx) => {
    const fresh = await tx.bill.findUnique({ where: { id }, select: { status: true } });
    if (!fresh || fresh.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
    for (const pc of payCalcs) {
      const pay = await tx.billPayment.create({ data: { billId: id, mode: pc.input.mode, bankAccountId: pc.bankAccountId ?? null, metal: pc.metal ?? null, metalForm: pc.metalForm ?? null, gross: pc.gross ?? null, net: pc.net ?? null, tunch: pc.tunch ?? null, fine: pc.fine ?? null, rate: pc.rate ?? null, amount: pc.amount, remark: pc.input.remark ?? null, txnDate, isActive: true, createdById: ctx.userId } });
      await ledger.post(tx, lctx, [paymentLedgerRow(pc, pay.id, id, bill.kind, bill.branchId, txnDate)]);
    }
    await tx.bill.update({ where: { id }, data: { paid: { increment: added } } }); // atomic — no lost update under concurrent payments
    if (!added.isZero()) {
      // Later payments always reduce the party's MONEY balance (SELL: party owes less; PURCHASE: shop owes less).
      await udhar.post(tx, lctx, [{ branchId: bill.branchId, partyId: bill.partyId, txnDate, source: billSource(bill.kind), sourceId: String(id), amount: added.times(bill.kind === 'SELL' ? -1 : 1), narration: `${bill.billNo} payment` }]);
    }
    await logActivity(tx, ctx, { module: bill.kind, action: 'EDITED', entity: 'BILL', entityId: String(id), summary: `Payment ₹${added.toFixed(2)} on ${bill.billNo}` });
  });
  return getBill(ctx, id);
}

// ───────────── Delete ─────────────

export async function deleteBill(ctx: TenantContext, id: number, returnStock: boolean): Promise<void> {
  const sdb = scopedDb(ctx);
  const bill = await sdb.bill.findFirst({ where: { id }, include: { items: true, payments: true } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  if (bill.status !== 'ACTIVE') throw new HttpError(409, 'CONFLICT', 'Bill is not active');
  const lctx = lctxOf(ctx);

  // PURCHASE return: every created item must still be AVAILABLE (not sold/transferred away).
  if (returnStock && bill.kind === 'PURCHASE') {
    const ids = bill.items.map((i) => i.stockItemId).filter((x): x is number => x != null);
    const items = ids.length ? await sdb.stockItem.findMany({ where: { id: { in: ids } } }) : [];
    for (const it of items) if (it.status !== 'AVAILABLE') throw new HttpError(409, 'CONFLICT', `Purchased item #${it.id} is no longer available — cannot return stock`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.bill.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date(), deletedWithStock: returnStock } });
    await tx.billPayment.updateMany({ where: { billId: id }, data: { isActive: false } });
    for (const p of bill.payments) await ledger.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: `${id}-P${p.id}` });
    await udhar.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: String(id) });

    if (returnStock) {
      await ledger.reverse(tx, lctx, { source: billSource(bill.kind), sourceId: String(id) }); // stock rows
      for (const it of bill.items) {
        if (it.stockItemId == null) continue;
        if (bill.kind === 'PURCHASE') {
          await tx.stockItem.update({ where: { id: it.stockItemId }, data: { status: 'DELETED' } });
          continue;
        }
        const stock = await tx.stockItem.findUnique({ where: { id: it.stockItemId } });
        if (!stock) continue;
        if (stock.method === 'LOOSE') {
          const g = D(stock.gross).plus(it.gross);
          const l = D(stock.less).plus(it.less);
          const net = Prisma.Decimal.max(g.minus(l), 0);
          const fine = net.times(D(stock.tunch)).div(100).times(D(stock.wastage).div(100).plus(1));
          await tx.stockItem.update({ where: { id: stock.id }, data: { gross: g, less: l, pcs: stock.pcs + it.pcs, net, fine, status: 'AVAILABLE' } });
        } else await tx.stockItem.update({ where: { id: stock.id }, data: { status: 'AVAILABLE' } });
      }
    }
    await logActivity(tx, ctx, { module: bill.kind, action: 'DELETED', entity: 'BILL', entityId: String(id), summary: `Deleted ${bill.kind === 'SELL' ? 'sell' : 'purchase'} bill ${bill.billNo}` });
  });
}

// ───────────── List / get + DTO mappers ─────────────

const lineDto = (i: any): BillLineDto => ({
  id: i.id, stockItemId: i.stockItemId, itemNameId: i.itemNameId, stockClass: i.stockClass, description: i.description, hsnCode: i.hsnCode, tagNo: i.tagNo, karatCode: i.karatCode,
  pcs: i.pcs, gross: String(i.gross), less: String(i.less), net: String(i.net), tunch: String(i.tunch), wastage: String(i.wastage), fine: String(i.fine), stoneCharge: String(i.stoneCharge),
  rate: String(i.rate), labour: String(i.labour), labourUnit: i.labourUnit, other: String(i.other), discount: String(i.discount), discountUnit: i.discountUnit, metalAmount: String(i.metalAmount), labourAmount: String(i.labourAmount), total: String(i.total),
});

const paymentDto = (p: any, baMap: Map<number, string>): BillPaymentDto => ({
  id: p.id, mode: p.mode, bankAccount: p.bankAccountId != null ? { id: p.bankAccountId, name: baMap.get(p.bankAccountId) ?? '' } : null, metal: p.metal, metalForm: p.metalForm,
  gross: p.gross != null ? String(p.gross) : null, net: p.net != null ? String(p.net) : null, tunch: p.tunch != null ? String(p.tunch) : null, fine: p.fine != null ? String(p.fine) : null, rate: p.rate != null ? String(p.rate) : null,
  amount: String(p.amount), remark: p.remark, txnDate: p.txnDate.toISOString().slice(0, 10), isActive: p.isActive, createdAt: p.createdAt.toISOString(),
});

const listItemFields = (b: any, party: PartyRefDto, branchName: string, createdBy: string | null): BillListItemDto => ({
  id: b.id, kind: b.kind, billType: b.billType, billNo: b.billNo, billDate: b.billDate.toISOString().slice(0, 10), party, branch: { id: b.branchId, name: branchName },
  itemCount: b._count?.items ?? b.items?.length ?? 0, final: String(b.final), paid: String(b.paid), balance: D(b.final).minus(b.paid).toFixed(2), keepBalanceAs: b.keepBalanceAs,
  keepWeight: b.keepWeight != null ? String(b.keepWeight) : null, status: b.status, createdBy, createdAt: b.createdAt.toISOString(),
});

const partyRef = (p: any): PartyRefDto => ({ id: p.id, type: p.type, name: p.name, mobile: p.mobile, shopName: p.shopName });

async function userNames(ctx: TenantContext, ids: number[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = await prisma.user.findMany({ where: { id: { in: uniq }, businessId: ctx.businessId! }, select: { id: true, name: true } });
  return new Map(rows.map((u) => [u.id, u.name]));
}

/** The bill's kind, scoped — for route-level per-kind permission gating (sell_bill vs purchase_bill). 404 if not visible. */
export async function billKind(ctx: TenantContext, id: number): Promise<BillKind> {
  const bill = await scopedDb(ctx).bill.findFirst({ where: { id }, select: { kind: true } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  return bill.kind;
}

export async function getBill(ctx: TenantContext, id: number): Promise<BillDto> {
  const bill = await scopedDb(ctx).bill.findFirst({ where: { id }, include: { items: { orderBy: { id: 'asc' } }, payments: { orderBy: { id: 'asc' } } } });
  if (!bill) throw new HttpError(404, 'NOT_FOUND', 'Bill not found');
  const sdb = scopedDb(ctx);
  const party = await sdb.party.findUnique({ where: { id: bill.partyId } });
  const branch = await sdb.branch.findUnique({ where: { id: bill.branchId }, select: { name: true } });
  const creator = (await userNames(ctx, bill.createdById != null ? [bill.createdById] : [])).get(bill.createdById!) ?? null;
  const baIds = [...new Set(bill.payments.map((p) => p.bankAccountId).filter((x): x is number => x != null))];
  const baMap = new Map((baIds.length ? await sdb.bankAccount.findMany({ where: { id: { in: baIds } }, select: { id: true, bankName: true } }) : []).map((b) => [b.id, b.bankName]));
  return {
    ...listItemFields(bill, partyRef(party), branch?.name ?? '', creator),
    dueDate: bill.dueDate ? bill.dueDate.toISOString().slice(0, 10) : null, interState: bill.interState, sub: String(bill.sub), discount: String(bill.discount), discountUnit: bill.discountUnit, discountAmount: String(bill.discountAmount),
    gstPercent: String(bill.gstPercent), taxable: String(bill.taxable), cgst: String(bill.cgst), sgst: String(bill.sgst), igst: String(bill.igst), total: String(bill.total), round: String(bill.round),
    keepRate: bill.keepRate != null ? String(bill.keepRate) : null, remark: bill.remark, deletedWithStock: bill.deletedWithStock, items: bill.items.map(lineDto), payments: bill.payments.map((p) => paymentDto(p, baMap)),
  };
}

export async function listBills(ctx: TenantContext, query: any): Promise<Paged<BillListItemDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { kind: query.kind, status: query.status, ...(query.billType ? { billType: query.billType } : {}), ...(query.partyId ? { partyId: query.partyId } : {}) };
  if (query.from || query.to) where.billDate = { ...(query.from ? { gte: ledger.businessDate(query.from) } : {}), ...(query.to ? { lte: ledger.businessDate(query.to) } : {}) };
  if (query.minTotal != null || query.maxTotal != null) where.final = { ...(query.minTotal != null ? { gte: query.minTotal } : {}), ...(query.maxTotal != null ? { lte: query.maxTotal } : {}) };
  if (query.pending === 'true') where.final = { ...(where.final ?? {}), not: prisma.bill.fields.paid };
  else if (query.pending === 'false') where.paid = prisma.bill.fields.final;
  if (query.q) {
    const parties = await sdb.party.findMany({ where: { OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { mobile: { contains: query.q } }] }, select: { id: true } });
    where.OR = [{ billNo: { contains: query.q, mode: 'insensitive' } }, { partyId: { in: parties.map((p) => p.id) } }];
  }
  const [rows, total] = await Promise.all([
    sdb.bill.findMany({ where, include: { _count: { select: { items: true } } }, orderBy: { id: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    sdb.bill.count({ where }),
  ]);
  const parties = new Map((await sdb.party.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.partyId))] } } })).map((p) => [p.id, p]));
  const branches = new Map((await sdb.branch.findMany({ where: { id: { in: [...new Set(rows.map((b) => b.branchId))] } }, select: { id: true, name: true } })).map((b) => [b.id, b.name]));
  const users = await userNames(ctx, rows.map((b) => b.createdById).filter((x): x is number => x != null));
  return {
    items: rows.map((b) => listItemFields(b, partyRef(parties.get(b.partyId)), branches.get(b.branchId) ?? '', b.createdById != null ? (users.get(b.createdById) ?? null) : null)),
    total, page: query.page, pageSize: query.pageSize,
  };
}
