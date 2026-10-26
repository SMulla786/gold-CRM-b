import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { businessDate } from '../../lib/ledger';
import type { TenantContext } from '../../middleware/context';
import { ACTIVITY_ACTIONS, B2CL_LIMIT } from '../../shared';
import type { ActivityDto, DashboardDto, Gstr1B2bRow, Gstr1B2csRow, Gstr1CdnrRow, Gstr1Dto, Gstr1HsnRow, Gstr1InvoiceRow, Gstr3bDto, GstRegisterRowDto, GstSummaryRowDto, HsnSummaryRowDto, Paged } from '../../shared';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase 6 read-only reports (docs/api-phase6.md). Every total is a SQL aggregate/groupBy through scopedDb or a
// branch-filtered raw query — rows are never loaded into JS to be summed.

const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (d: Prisma.Decimal) => d.toFixed(2);
const wt = (d: Prisma.Decimal) => d.toFixed(3);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
/** Admin with X-Branch-Id:all → whole subtree; otherwise just the active branch (own branch for branch users). */
const branchFilter = (ctx: TenantContext): number[] => (ctx.activeBranchId != null ? [ctx.activeBranchId] : ctx.branchIds);
const sqlScope = (ctx: TenantContext, branches: number[]) => Prisma.sql`"businessId" = ${ctx.businessId!} AND "branchId" IN (${Prisma.join(branches)})`;

// ───────────── Dashboard ─────────────

export async function dashboard(ctx: TenantContext): Promise<DashboardDto> {
  const sdb = scopedDb(ctx);
  const branches = branchFilter(ctx);
  const today = businessDate();
  const todayStr = dateOnly(today);
  const [y, m] = todayStr.split('-').map(Number) as [number, number];
  const monthStart = new Date(`${todayStr.slice(0, 7)}-01T00:00:00Z`);
  const fyStartYear = m >= 4 ? y : y - 1;
  const yearStart = new Date(`${fyStartYear}-04-01T00:00:00Z`);
  const istTodayStart = new Date(today.getTime() - 330 * 60_000); // IST midnight in UTC, for createdAt timestamps
  const scope = sqlScope(ctx, branches);
  const sell = { kind: 'SELL' as const, status: 'ACTIVE' as const, branchId: { in: branches } };

  const [customers, suppliers, customersNewThisMonth, stockRows, todayAgg, monthAgg, yearAgg, purchaseMonth, cashInRows, cashBankRows, actRows] =
    await Promise.all([
      sdb.party.count({ where: { type: 'CUSTOMER', isActive: true } }),
      sdb.party.count({ where: { type: 'SUPPLIER', isActive: true } }),
      sdb.party.count({ where: { type: 'CUSTOMER', createdAt: { gte: monthStart } } }),
      sdb.stockItem.groupBy({ by: ['stockClass'], where: { status: 'AVAILABLE', branchId: { in: branches } }, _count: { _all: true }, _sum: { pcs: true, net: true, fine: true, purchaseCost: true } }),
      sdb.bill.aggregate({ where: { ...sell, billDate: today }, _sum: { final: true, paid: true }, _count: { _all: true } }),
      sdb.bill.aggregate({ where: { ...sell, billDate: { gte: monthStart } }, _sum: { final: true } }),
      sdb.bill.aggregate({ where: { ...sell, billDate: { gte: yearStart } }, _sum: { final: true } }),
      sdb.bill.aggregate({ where: { kind: 'PURCHASE', status: 'ACTIVE', branchId: { in: branches }, billDate: { gte: monthStart } }, _sum: { final: true } }),
      sdb.ledgerEntry.groupBy({ by: ['direction'], where: { asset: 'MONEY', bankAccountId: null, branchId: { in: branches } }, _sum: { amount: true } }),
      sdb.ledgerEntry.groupBy({ by: ['direction'], where: { asset: 'MONEY', bankAccountId: { not: null }, branchId: { in: branches } }, _sum: { amount: true } }),
      sdb.activityLog.groupBy({ by: ['action'], where: { branchId: { in: branches }, createdAt: { gte: istTodayStart } }, _count: { _all: true } }),
    ]);

  // raw aggregates that need column arithmetic / positive-only filtering
  const [pendRow, udhRow, collRow, monthlyRows] = await Promise.all([
    prisma.$queryRaw<{ s: Prisma.Decimal | null }[]>(Prisma.sql`SELECT COALESCE(SUM(final - paid),0)::numeric AS s FROM "Bill" WHERE ${scope} AND kind::text='SELL' AND status::text='ACTIVE' AND final > paid`),
    prisma.$queryRaw<{ amount: Prisma.Decimal; gold: Prisma.Decimal; silver: Prisma.Decimal }[]>(Prisma.sql`
      SELECT
        (SELECT COALESCE(SUM(v),0)::numeric FROM (SELECT SUM(amount) v FROM "UdharEntry" WHERE ${scope} GROUP BY "partyId") a WHERE v > 0) AS amount,
        (SELECT COALESCE(SUM(v),0)::numeric FROM (SELECT SUM(gold)   v FROM "UdharEntry" WHERE ${scope} GROUP BY "partyId") a WHERE v > 0) AS gold,
        (SELECT COALESCE(SUM(v),0)::numeric FROM (SELECT SUM(silver) v FROM "UdharEntry" WHERE ${scope} GROUP BY "partyId") a WHERE v > 0) AS silver`),
    // shortcut: "collected this month" = money received into party accounts = −Σ negative UDHAR amount movements this month; refine if the dashboard needs online/cash split.
    prisma.$queryRaw<{ s: Prisma.Decimal | null }[]>(Prisma.sql`SELECT COALESCE(SUM(amount),0)::numeric AS s FROM "UdharEntry" WHERE ${scope} AND source='UDHAR' AND amount < 0 AND "txnDate" >= ${dateOnly(monthStart)}::date`),
    prisma.$queryRaw<{ ym: string; k: string; v: Prisma.Decimal }[]>(Prisma.sql`SELECT to_char("billDate",'YYYY-MM') AS ym, kind::text AS k, COALESCE(SUM(final),0)::numeric AS v FROM "Bill" WHERE ${scope} AND status::text='ACTIVE' AND kind::text IN ('SELL','PURCHASE') GROUP BY 1,2`),
  ]);

  const dirSum = (rows: { direction: 'IN' | 'OUT'; _sum: { amount: Prisma.Decimal | null } }[]) =>
    rows.reduce((a, r) => (r.direction === 'IN' ? a.plus(D(r._sum.amount)) : a.minus(D(r._sum.amount))), new Prisma.Decimal(0));

  const activityToday = Object.fromEntries(ACTIVITY_ACTIONS.map((a) => [a, 0])) as Record<(typeof ACTIVITY_ACTIONS)[number], number>;
  for (const r of actRows) activityToday[r.action] = r._count._all;

  // 12-month series oldest first
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(dt.toISOString().slice(0, 7));
  }
  const monthlyMap = new Map<string, { sales: Prisma.Decimal; purchases: Prisma.Decimal }>();
  for (const r of monthlyRows) {
    const e = monthlyMap.get(r.ym) ?? { sales: new Prisma.Decimal(0), purchases: new Prisma.Decimal(0) };
    if (r.k === 'SELL') e.sales = e.sales.plus(D(r.v));
    else e.purchases = e.purchases.plus(D(r.v));
    monthlyMap.set(r.ym, e);
  }
  const monthly = months.map((mo) => ({ month: mo, sales: money(monthlyMap.get(mo)?.sales ?? new Prisma.Decimal(0)), purchases: money(monthlyMap.get(mo)?.purchases ?? new Prisma.Decimal(0)) }));

  let byBranch: DashboardDto['byBranch'] = null;
  if (ctx.level === 'ADMIN' && ctx.activeBranchId == null) {
    const [tRows, mRows, brs] = await Promise.all([
      sdb.bill.groupBy({ by: ['branchId'], where: { ...sell, billDate: today }, _sum: { final: true } }),
      sdb.bill.groupBy({ by: ['branchId'], where: { ...sell, billDate: { gte: monthStart } }, _sum: { final: true } }),
      sdb.branch.findMany({ where: { id: { in: branches } }, select: { id: true, name: true } }),
    ]);
    const tMap = new Map(tRows.map((r) => [r.branchId, D(r._sum.final)]));
    const mMap = new Map(mRows.map((r) => [r.branchId, D(r._sum.final)]));
    byBranch = brs.map((b) => ({ branch: { id: b.id, name: b.name }, todayTotal: money(tMap.get(b.id) ?? new Prisma.Decimal(0)), monthTotal: money(mMap.get(b.id) ?? new Prisma.Decimal(0)) }));
  }

  return {
    date: todayStr,
    parties: { customers, suppliers, customersNewThisMonth },
    stock: stockRows.map((r) => ({ stockClass: r.stockClass, items: r._count._all, pcs: Number(r._sum.pcs ?? 0), net: wt(D(r._sum.net)), fine: wt(D(r._sum.fine)), value: money(D(r._sum.purchaseCost)) })),
    sales: {
      todayTotal: money(D(todayAgg._sum.final)),
      todayCount: todayAgg._count._all,
      todayReceived: money(D(todayAgg._sum.paid)), // shortcut: Σ paid of bills dated today (not a separate payments-today ledger scan)
      monthTotal: money(D(monthAgg._sum.final)),
      yearTotal: money(D(yearAgg._sum.final)),
      pendingBalance: money(D(pendRow[0]?.s)),
    },
    purchases: { monthTotal: money(D(purchaseMonth._sum.final)) },
    udhari: { amount: money(D(udhRow[0]?.amount)), gold: wt(D(udhRow[0]?.gold)), silver: wt(D(udhRow[0]?.silver)), collectedThisMonth: money(D(collRow[0]?.s).negated()) },
    cash: { inHand: money(dirSum(cashInRows)), bank: money(dirSum(cashBankRows)) },
    activityToday,
    monthly,
    byBranch,
  };
}

// ───────────── Activity ─────────────

export async function activity(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; from?: Date; to?: Date; module?: string; action?: (typeof ACTIVITY_ACTIONS)[number]; userId?: number }): Promise<Paged<ActivityDto>> {
  const sdb = scopedDb(ctx);
  const branches = branchFilter(ctx);
  const where: any = {
    branchId: { in: branches },
    // q (from pageQuery) searches the human-readable text: summary + party name.
    ...(q.q ? { OR: [{ summary: { contains: q.q, mode: 'insensitive' } }, { partyName: { contains: q.q, mode: 'insensitive' } }] } : {}),
    ...(q.module ? { module: q.module } : {}),
    ...(q.action ? { action: q.action } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    sdb.activityLog.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    sdb.activityLog.count({ where }),
  ]);
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is number => x != null))];
  const branchIds = [...new Set(rows.map((r) => r.branchId).filter((x): x is number => x != null))];
  const [users, brs] = await Promise.all([
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds }, businessId: ctx.businessId! }, select: { id: true, name: true } }) : [],
    branchIds.length ? sdb.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }) : [],
  ]);
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  const bMap = new Map(brs.map((b) => [b.id, b.name]));
  const items: ActivityDto[] = rows.map((r) => ({
    id: String(r.id),
    createdAt: r.createdAt.toISOString(),
    module: r.module,
    action: r.action,
    summary: r.summary,
    partyName: r.partyName,
    entity: r.entity,
    entityId: r.entityId,
    user: r.userId != null ? (uMap.get(r.userId) ?? null) : null,
    branch: r.branchId != null ? { id: r.branchId, name: bMap.get(r.branchId) ?? '' } : null,
  }));
  return { items, total, page: q.page, pageSize: q.pageSize };
}

// ───────────── GST reports (ACTIVE GST bills only) ─────────────

const gstDateWhere = (from?: Date, to?: Date) => (from || to ? { billDate: { ...(from ? { gte: businessDate(from) } : {}), ...(to ? { lte: businessDate(to) } : {}) } } : {});

export async function gstRegister(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; from?: Date; to?: Date; kind: 'SELL' | 'PURCHASE' }): Promise<Paged<GstRegisterRowDto>> {
  const sdb = scopedDb(ctx);
  // keyword: bill no. or party name / mobile / GSTIN
  const kwParties = q.q ? (await sdb.party.findMany({ where: { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { mobile: { contains: q.q } }, { gstin: { contains: q.q, mode: 'insensitive' } }] }, select: { id: true } })).map((p) => p.id) : [];
  const where: any = {
    kind: q.kind, billType: 'GST', status: 'ACTIVE', branchId: { in: branchFilter(ctx) }, ...gstDateWhere(q.from, q.to),
    ...(q.q ? { OR: [{ billNo: { contains: q.q, mode: 'insensitive' } }, { partyId: { in: kwParties } }] } : {}),
  };
  const [bills, total] = await Promise.all([
    sdb.bill.findMany({ where, include: { items: { select: { hsnCode: true } } }, orderBy: [{ billDate: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    sdb.bill.count({ where }),
  ]);
  const partyIds = [...new Set(bills.map((b) => b.partyId))];
  const parties = partyIds.length ? await sdb.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, name: true, gstin: true } }) : [];
  const pMap = new Map(parties.map((p) => [p.id, p]));
  const items: GstRegisterRowDto[] = bills.map((b) => {
    const p = pMap.get(b.partyId);
    return {
      billId: b.id,
      billNo: b.billNo,
      billDate: dateOnly(b.billDate),
      party: { id: b.partyId, name: p?.name ?? '', gstin: p?.gstin ?? null },
      hsnCodes: [...new Set(b.items.map((i) => i.hsnCode).filter((x): x is string => !!x))],
      taxable: money(D(b.taxable)),
      cgst: money(D(b.cgst)),
      sgst: money(D(b.sgst)),
      igst: money(D(b.igst)),
      total: money(D(b.final)),
      gstPercent: D(b.gstPercent).toString(), // stored bill rate (one rate per bill), e.g. '3' — same source as GSTR-1
      itcEligibility: b.itcEligibility,
      itcBlockReason: b.itcBlockReason,
      supplierInvoiceNo: b.supplierInvoiceNo,
      supplyCategory: b.supplyCategory,
      reverseCharge: b.reverseCharge,
    };
  });
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function gstHsn(ctx: TenantContext, q: { from?: Date; to?: Date }): Promise<HsnSummaryRowDto[]> {
  const branches = branchFilter(ctx);
  const from = q.from ? dateOnly(businessDate(q.from)) : null;
  const to = q.to ? dateOnly(businessDate(q.to)) : null;
  const conds: Prisma.Sql[] = [
    Prisma.sql`b."businessId" = ${ctx.businessId!}`,
    Prisma.sql`b."branchId" IN (${Prisma.join(branches)})`,
    Prisma.sql`b.kind::text = 'SELL'`,
    Prisma.sql`b."billType"::text = 'GST'`,
    Prisma.sql`b.status::text = 'ACTIVE'`,
    Prisma.sql`bi."hsnCode" IS NOT NULL`,
  ];
  if (from) conds.push(Prisma.sql`b."billDate" >= ${from}::date`);
  if (to) conds.push(Prisma.sql`b."billDate" <= ${to}::date`);
  // per-HSN taxable/GST split pro-rata by the line's share of its bill total (bill-level GST, line-level HSN).
  const rows = await prisma.$queryRaw<{ hsnCode: string; stockClass: string; weight: Prisma.Decimal; taxable: Prisma.Decimal; cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal; total: Prisma.Decimal }[]>(Prisma.sql`
    SELECT bi."hsnCode" AS "hsnCode", bi."stockClass"::text AS "stockClass",
      COALESCE(SUM(bi.fine),0)::numeric AS weight,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.taxable),0)::numeric AS taxable,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.cgst),0)::numeric AS cgst,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.sgst),0)::numeric AS sgst,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.igst),0)::numeric AS igst,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.final),0)::numeric AS total
    FROM "BillItem" bi JOIN "Bill" b ON b.id = bi."billId"
    WHERE ${Prisma.join(conds, ' AND ')}
    GROUP BY bi."hsnCode", bi."stockClass"
    ORDER BY bi."hsnCode"`);
  return rows.map((r) => ({ hsnCode: r.hsnCode, stockClass: r.stockClass, weight: wt(D(r.weight)), taxable: money(D(r.taxable)), cgst: money(D(r.cgst)), sgst: money(D(r.sgst)), igst: money(D(r.igst)), total: money(D(r.total)) }));
}

export async function gstSummary(ctx: TenantContext, q: { from?: Date; to?: Date; groupBy: 'MONTH' | 'QUARTER' | 'YEAR' }): Promise<GstSummaryRowDto[]> {
  // group by month in SQL (groupBy can't to_char), then bucket to MONTH/QUARTER/FY in app (period count is small).
  const from = q.from ? dateOnly(businessDate(q.from)) : null;
  const to = q.to ? dateOnly(businessDate(q.to)) : null;
  const conds: Prisma.Sql[] = [sqlScope(ctx, branchFilter(ctx)), Prisma.sql`"billType"::text='GST'`, Prisma.sql`status::text='ACTIVE'`];
  if (from) conds.push(Prisma.sql`"billDate" >= ${from}::date`);
  if (to) conds.push(Prisma.sql`"billDate" <= ${to}::date`);
  const raw = await prisma.$queryRaw<{ ym: string; k: string; taxable: Prisma.Decimal; gst: Prisma.Decimal }[]>(Prisma.sql`
    SELECT to_char("billDate",'YYYY-MM') AS ym, kind::text AS k,
      COALESCE(SUM(taxable),0)::numeric AS taxable, COALESCE(SUM(cgst+sgst+igst),0)::numeric AS gst
    FROM "Bill" WHERE ${Prisma.join(conds, ' AND ')} GROUP BY 1,2`);

  const periodOf = (ym: string): string => {
    const [yy, mm] = ym.split('-').map(Number) as [number, number];
    if (q.groupBy === 'MONTH') return ym;
    const fy = mm >= 4 ? yy : yy - 1; // FY Apr–Mar
    const yy2 = (n: number) => String(n % 100).padStart(2, '0');
    // FY quarter: Apr–Jun = Q1 … Jan–Mar = Q4, e.g. 'FY26-27 Q1' (sorts chronologically as a string)
    if (q.groupBy === 'QUARTER') return `FY${yy2(fy)}-${yy2(fy + 1)} Q${Math.floor(((mm + 8) % 12) / 3) + 1}`;
    return `FY${fy}-${yy2(fy + 1)}`;
  };
  const map = new Map<string, { salesTaxable: Prisma.Decimal; purchaseTaxable: Prisma.Decimal; outputGst: Prisma.Decimal; inputGst: Prisma.Decimal }>();
  for (const r of raw) {
    const key = periodOf(r.ym);
    const e = map.get(key) ?? { salesTaxable: new Prisma.Decimal(0), purchaseTaxable: new Prisma.Decimal(0), outputGst: new Prisma.Decimal(0), inputGst: new Prisma.Decimal(0) };
    if (r.k === 'SELL') {
      e.salesTaxable = e.salesTaxable.plus(D(r.taxable));
      e.outputGst = e.outputGst.plus(D(r.gst));
    } else {
      e.purchaseTaxable = e.purchaseTaxable.plus(D(r.taxable));
      e.inputGst = e.inputGst.plus(D(r.gst));
    }
    map.set(key, e);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([period, e]) => ({ period, salesTaxable: money(e.salesTaxable), purchaseTaxable: money(e.purchaseTaxable), outputGst: money(e.outputGst), inputGst: money(e.inputGst), netPayable: money(e.outputGst.minus(e.inputGst)) }));
}

// ───────────── Phase 12: GSTR-1 / GSTR-3B (docs/api-phase12.md) ─────────────
// Read-only; every figure is a SQL aggregate over STORED bill fields (never recomputed) so register, GSTR-1 and
// GSTR-3B always reconcile. GST is bill-level (one rate per bill); HSN is line-level and pro-rated like gstHsn.

interface InvRow { id: number; billNo: string; billDate: Date; final: Prisma.Decimal; gstPercent: Prisma.Decimal; interState: boolean; taxable: Prisma.Decimal; cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal; gstin: string | null; party: string; stateId: number | null; deletedAt: Date | null }
type Cols = { taxable: Prisma.Decimal; cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal };

const pos2 = (code: number | null): string => (code != null ? String(code).padStart(2, '0') : '');
const ddmmyyyy = (iso: string): string => { const [y, m, d] = iso.split('-'); return `${d}-${m}-${y}`; };

/** Shop GSTIN + state code: active branch override → business (as in /app/business-profile). */
async function shopIdentity(ctx: TenantContext): Promise<{ gstin: string | null; stateCode: number | null }> {
  const sdb = scopedDb(ctx);
  const [branch, business] = await Promise.all([
    ctx.activeBranchId != null ? sdb.branch.findUnique({ where: { id: ctx.activeBranchId }, select: { gstin: true, stateId: true } }) : Promise.resolve(null),
    prisma.business.findUnique({ where: { id: ctx.businessId! }, select: { gstin: true, stateId: true } }),
  ]);
  return { gstin: branch?.gstin ?? business?.gstin ?? null, stateCode: branch?.stateId ?? business?.stateId ?? null };
}

export async function gstr1(ctx: TenantContext, q: { from: Date; to: Date }): Promise<Gstr1Dto> {
  const branches = branchFilter(ctx);
  const from = dateOnly(businessDate(q.from));
  const to = dateOnly(businessDate(q.to));
  const shop = await shopIdentity(ctx);
  const posOf = (stateId: number | null) => pos2(stateId ?? shop.stateCode);
  const scope = Prisma.sql`b."businessId" = ${ctx.businessId!} AND b."branchId" IN (${Prisma.join(branches)})`;

  // One read of every ACTIVE GST sell bill in the period feeds B2B / B2CL / B2CS and the totals (reconciles with the register — no per-bill query).
  const inv = await prisma.$queryRaw<InvRow[]>(Prisma.sql`
    SELECT b.id, b."billNo", b."billDate", b.final, b."gstPercent", b."interState", b.taxable, b.cgst, b.sgst, b.igst, p.gstin, p.name AS party, p."stateId", b."deletedAt"
    FROM "Bill" b JOIN "Party" p ON p.id = b."partyId"
    WHERE ${scope} AND b.kind::text='SELL' AND b."billType"::text='GST' AND b.status::text='ACTIVE'
      AND b."billDate" >= ${from}::date AND b."billDate" <= ${to}::date
    ORDER BY b."billDate", b.id`);

  const b2b: Gstr1B2bRow[] = [];
  const b2cl: Gstr1InvoiceRow[] = [];
  const b2csMap = new Map<string, Cols & { pos: string; rate: string; supplyType: 'INTRA' | 'INTER' }>();
  const addB2cs = (pos: string, rate: string, inter: boolean, c: Cols, sign: 1 | -1) => {
    const supplyType = inter ? 'INTER' : 'INTRA';
    const key = `${pos}|${rate}|${supplyType}`;
    const e = b2csMap.get(key) ?? { pos, rate, supplyType, taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
    e.taxable = e.taxable.plus(c.taxable.times(sign)); e.cgst = e.cgst.plus(c.cgst.times(sign)); e.sgst = e.sgst.plus(c.sgst.times(sign)); e.igst = e.igst.plus(c.igst.times(sign));
    b2csMap.set(key, e);
  };
  const totals = { taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
  for (const r of inv) {
    const rate = String(r.gstPercent);
    const pos = posOf(r.stateId);
    const c: Cols = { taxable: D(r.taxable), cgst: D(r.cgst), sgst: D(r.sgst), igst: D(r.igst) };
    totals.taxable = totals.taxable.plus(c.taxable); totals.cgst = totals.cgst.plus(c.cgst); totals.sgst = totals.sgst.plus(c.sgst); totals.igst = totals.igst.plus(c.igst);
    const cols = { taxable: money(c.taxable), cgst: money(c.cgst), sgst: money(c.sgst), igst: money(c.igst) };
    if (r.gstin) b2b.push({ billId: r.id, invNo: r.billNo, invDate: dateOnly(r.billDate), invValue: money(D(r.final)), pos, rate, gstin: r.gstin, party: r.party, ...cols });
    else if (r.interState && D(r.final).gt(B2CL_LIMIT)) b2cl.push({ billId: r.id, invNo: r.billNo, invDate: dateOnly(r.billDate), invValue: money(D(r.final)), pos, rate, ...cols });
    else addB2cs(pos, rate, r.interState, c, 1);
  }

  // Credit notes: a GST sell bill filed in an earlier period (billDate < from) but deleted inside it (deletedAt in period).
  const cnInv = await prisma.$queryRaw<InvRow[]>(Prisma.sql`
    SELECT b.id, b."billNo", b."billDate", b.final, b."gstPercent", b."interState", b.taxable, b.cgst, b.sgst, b.igst, p.gstin, p.name AS party, p."stateId", b."deletedAt"
    FROM "Bill" b JOIN "Party" p ON p.id = b."partyId"
    WHERE ${scope} AND b.kind::text='SELL' AND b."billType"::text='GST' AND b.status::text='DELETED'
      AND b."billDate" < ${from}::date AND (b."deletedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date -- IST business date
    ORDER BY b."deletedAt", b.id`);
  const cdnr: Gstr1CdnrRow[] = [];
  for (const r of cnInv) {
    const rate = String(r.gstPercent);
    const pos = posOf(r.stateId);
    const c: Cols = { taxable: D(r.taxable), cgst: D(r.cgst), sgst: D(r.sgst), igst: D(r.igst) };
    if (r.gstin) cdnr.push({ billId: r.id, invNo: r.billNo, invDate: dateOnly(r.billDate), noteDate: r.deletedAt ? dateOnly(new Date(r.deletedAt.getTime() + 330 * 60000)) : dateOnly(r.billDate) /* IST day */, invValue: money(D(r.final)), pos, rate, gstin: r.gstin, party: r.party, taxable: money(c.taxable), cgst: money(c.cgst), sgst: money(c.sgst), igst: money(c.igst) });
    else addB2cs(pos, rate, r.interState, c, -1); // unregistered credit note → negative B2CS
  }
  const b2cs: Gstr1B2csRow[] = [...b2csMap.values()].map((e) => ({ pos: e.pos, rate: e.rate, supplyType: e.supplyType, taxable: money(e.taxable), cgst: money(e.cgst), sgst: money(e.sgst), igst: money(e.igst) }));

  // HSN (line-level, pro-rated by the line's share of its bill total), grouped by HSN + rate + uqc, split B2B/B2C.
  const hsnRaw = await prisma.$queryRaw<{ hsnCode: string; rate: Prisma.Decimal; isMetal: boolean; isB2b: boolean; qty: Prisma.Decimal; taxable: Prisma.Decimal; cgst: Prisma.Decimal; sgst: Prisma.Decimal; igst: Prisma.Decimal; total: Prisma.Decimal }[]>(Prisma.sql`
    SELECT bi."hsnCode" AS "hsnCode", b."gstPercent" AS rate, (bi."stockClass" IN ('GOLD','SILVER')) AS "isMetal", (p.gstin IS NOT NULL) AS "isB2b",
      COALESCE(SUM(CASE WHEN bi."stockClass" IN ('GOLD','SILVER') THEN bi.net ELSE bi.pcs END),0)::numeric AS qty,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.taxable),0)::numeric AS taxable,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.cgst),0)::numeric AS cgst,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.sgst),0)::numeric AS sgst,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.igst),0)::numeric AS igst,
      COALESCE(SUM(bi.total / NULLIF(b.total,0) * b.final),0)::numeric AS total
    FROM "BillItem" bi JOIN "Bill" b ON b.id = bi."billId" JOIN "Party" p ON p.id = b."partyId"
    WHERE ${scope} AND b.kind::text='SELL' AND b."billType"::text='GST' AND b.status::text='ACTIVE'
      AND b."billDate" >= ${from}::date AND b."billDate" <= ${to}::date AND bi."hsnCode" IS NOT NULL
    GROUP BY bi."hsnCode", b."gstPercent", (bi."stockClass" IN ('GOLD','SILVER')), (p.gstin IS NOT NULL)
    ORDER BY bi."hsnCode"`);
  const hsnRow = (r: (typeof hsnRaw)[number]): Gstr1HsnRow => ({ hsnCode: r.hsnCode, uqc: r.isMetal ? 'GMS' : 'PCS', qty: r.isMetal ? wt(D(r.qty)) : String(Math.round(Number(r.qty))), rate: String(r.rate), taxable: money(D(r.taxable)), cgst: money(D(r.cgst)), sgst: money(D(r.sgst)), igst: money(D(r.igst)), total: money(D(r.total)) });
  const hsnB2b = hsnRaw.filter((r) => r.isB2b).map(hsnRow);
  const hsnB2c = hsnRaw.filter((r) => !r.isB2b).map(hsnRow);

  // docIssue: issued GST sell documents in the period (active + cancelled), per series (prefix before the trailing number).
  const di = await prisma.$queryRaw<{ series: string; from: string; to: string; total: number; cancelled: number }[]>(Prisma.sql`
    SELECT regexp_replace(b."billNo", '[0-9]+$', '') AS series, MIN(b."billNo") AS "from", MAX(b."billNo") AS "to",
      COUNT(*)::int AS total, COUNT(*) FILTER (WHERE b.status::text='DELETED')::int AS cancelled
    FROM "Bill" b
    WHERE ${scope} AND b.kind::text='SELL' AND b."billType"::text='GST'
      AND b."billDate" >= ${from}::date AND b."billDate" <= ${to}::date AND b.status::text IN ('ACTIVE','DELETED')
    GROUP BY 1 ORDER BY 1`);

  return {
    from, to, gstin: shop.gstin, b2b, b2cl, b2cs, hsnB2b, hsnB2c, cdnr,
    docIssue: di.map((d) => ({ series: d.series, from: d.from, to: d.to, total: Number(d.total), cancelled: Number(d.cancelled) })),
    totals: { taxable: money(totals.taxable), cgst: money(totals.cgst), sgst: money(totals.sgst), igst: money(totals.igst), invoices: inv.length },
  };
}

export async function gstr3b(ctx: TenantContext, q: { from: Date; to: Date }): Promise<Gstr3bDto> {
  const from = dateOnly(businessDate(q.from));
  const to = dateOnly(businessDate(q.to));
  const scope = sqlScope(ctx, branchFilter(ctx));
  const shop = await shopIdentity(ctx);
  const period = Prisma.sql`b."billDate" >= ${from}::date AND b."billDate" <= ${to}::date`;

  const sums = Prisma.sql`COALESCE(SUM(b.taxable),0)::numeric AS taxable, COALESCE(SUM(b.cgst),0)::numeric AS cgst, COALESCE(SUM(b.sgst),0)::numeric AS sgst, COALESCE(SUM(b.igst),0)::numeric AS igst`;
  const [outRows, nonRow, itcRows, rcmRow] = await Promise.all([
    // same bill set as before, split by supplyCategory (3.1 a/b/c/e)
    prisma.$queryRaw<(Cols & { k: string })[]>(Prisma.sql`SELECT b."supplyCategory"::text AS k, ${sums} FROM "Bill" b WHERE ${scope} AND b.kind::text='SELL' AND b."billType"::text='GST' AND b.status::text='ACTIVE' AND ${period} GROUP BY 1`),
    prisma.$queryRaw<{ s: Prisma.Decimal }[]>(Prisma.sql`SELECT COALESCE(SUM(final),0)::numeric AS s FROM "Bill" b WHERE ${scope} AND b.kind::text='SELL' AND b."billType"::text='ROUGH' AND b.status::text='ACTIVE' AND ${period}`),
    // ITC split by itcEligibility; a reverse-charge purchase is claimable even from an unregistered supplier
    prisma.$queryRaw<(Cols & { k: string })[]>(Prisma.sql`SELECT b."itcEligibility"::text AS k, ${sums} FROM "Bill" b JOIN "Party" p ON p.id = b."partyId" WHERE b."businessId" = ${ctx.businessId!} AND b."branchId" IN (${Prisma.join(branchFilter(ctx))}) AND b.kind::text='PURCHASE' AND b."billType"::text='GST' AND b.status::text='ACTIVE' AND (p.gstin IS NOT NULL OR b."reverseCharge") AND ${period} GROUP BY 1`),
    prisma.$queryRaw<Cols[]>(Prisma.sql`SELECT ${sums} FROM "Bill" b WHERE ${scope} AND b.kind::text='PURCHASE' AND b."billType"::text='GST' AND b.status::text='ACTIVE' AND b."reverseCharge" AND ${period}`),
  ]);
  const zero: Cols = { taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
  const pick = (rows: (Cols & { k: string })[], k: string): Cols => rows.find((r) => r.k === k) ?? zero;
  const cols = (c: Cols) => ({ taxable: money(D(c.taxable)), cgst: money(D(c.cgst)), sgst: money(D(c.sgst)), igst: money(D(c.igst)) });
  const tax = (c: Cols) => ({ cgst: money(D(c.cgst)), sgst: money(D(c.sgst)), igst: money(D(c.igst)) });
  const taxOf = (c: Cols) => D(c.cgst).plus(c.sgst).plus(c.igst);
  const sumOf = (rows: Cols[], f: (c: Cols) => Prisma.Decimal) => rows.reduce((a, c) => a.plus(f(c)), D(0));
  const eligible = pick(itcRows, 'ELIGIBLE');
  const rcm = rcmRow[0]!;
  // output tax over every GST sell bill (unchanged) + RCM tax payable on inward supplies − eligible ITC only (blocked/ineligible never offset)
  const net = sumOf(outRows, taxOf).plus(taxOf(rcm)).minus(taxOf(eligible));
  return {
    from, to, gstin: shop.gstin,
    outward: { ...cols(pick(outRows, 'TAXABLE')), zeroRated: cols(pick(outRows, 'ZERO_RATED')), nilExempt: cols(pick(outRows, 'NIL_EXEMPT')), nonGst: cols(pick(outRows, 'NON_GST')), reverseCharge: cols(rcm) },
    nonGst: money(D(nonRow[0]!.s)),
    itc: { ...tax(eligible), eligible: tax(eligible), reversed: tax(pick(itcRows, 'BLOCKED_17_5')), ineligible: tax(pick(itcRows, 'INELIGIBLE')), taxable: money(sumOf(itcRows, (c) => D(c.taxable))) },
    netPayableIndicative: money(net.isNegative() ? D(0) : net),
  };
}

/** GSTN offline-tool JSON (field names per the tool); amounts are 2-dp numbers. */
export async function gstr1Json(ctx: TenantContext, q: { from: Date; to: Date }): Promise<Record<string, unknown>> {
  const d = await gstr1(ctx, q);
  const m = businessDate(q.from);
  const fp = `${String(m.getUTCMonth() + 1).padStart(2, '0')}${m.getUTCFullYear()}`;
  const n = (s: string) => Number(s);
  const itms = (r: { rate: string; taxable: string; cgst: string; sgst: string; igst: string }) => [{ num: 1, itm_det: { rt: n(r.rate), txval: n(r.taxable), camt: n(r.cgst), samt: n(r.sgst), iamt: n(r.igst) } }];

  const byCtin = new Map<string, any[]>();
  for (const r of d.b2b) {
    const inv = { inum: r.invNo, idt: ddmmyyyy(r.invDate), val: n(r.invValue), pos: r.pos, rchrg: 'N', inv_typ: 'R', itms: itms(r) };
    (byCtin.get(r.gstin) ?? byCtin.set(r.gstin, []).get(r.gstin)!).push(inv);
  }
  const b2b = [...byCtin.entries()].map(([ctin, inv]) => ({ ctin, inv }));

  const byPos = new Map<string, any[]>();
  for (const r of d.b2cl) {
    const inv = { inum: r.invNo, idt: ddmmyyyy(r.invDate), val: n(r.invValue), itms: itms(r) };
    (byPos.get(r.pos) ?? byPos.set(r.pos, []).get(r.pos)!).push(inv);
  }
  const b2cl = [...byPos.entries()].map(([pos, inv]) => ({ pos, inv }));

  const b2cs = d.b2cs.map((r) => ({ sply_ty: r.supplyType, pos: r.pos, typ: 'OE', rt: n(r.rate), txval: n(r.taxable), camt: n(r.cgst), samt: n(r.sgst), iamt: n(r.igst) }));

  const hsnItem = (r: Gstr1HsnRow, i: number) => ({ num: i + 1, hsn_sc: r.hsnCode, uqc: r.uqc, qty: n(r.qty), rt: n(r.rate), txval: n(r.taxable), camt: n(r.cgst), samt: n(r.sgst), iamt: n(r.igst) });
  const hsn = { hsn_b2b: d.hsnB2b.map(hsnItem), hsn_b2c: d.hsnB2c.map(hsnItem) };

  const cnByCtin = new Map<string, any[]>();
  for (const r of d.cdnr) {
    const nt = { ntty: 'C', nt_num: r.invNo, nt_dt: ddmmyyyy(r.noteDate), val: n(r.invValue), pos: r.pos, rchrg: 'N', itms: itms(r) };
    (cnByCtin.get(r.gstin) ?? cnByCtin.set(r.gstin, []).get(r.gstin)!).push(nt);
  }
  const cdnr = [...cnByCtin.entries()].map(([ctin, nt]) => ({ ctin, nt }));

  const doc_issue = { doc_det: [{ doc_num: 1, docs: d.docIssue.map((s, i) => ({ num: i + 1, from: s.from, to: s.to, totnum: s.total, cancel: s.cancelled, net_issue: s.total - s.cancelled })) }] };

  return { gstin: d.gstin, fp, b2b, b2cl, b2cs, hsn, cdnr, doc_issue };
}
