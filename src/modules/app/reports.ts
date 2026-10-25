import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { businessDate } from '../../lib/ledger';
import type { TenantContext } from '../../middleware/context';
import { ACTIVITY_ACTIONS } from '../../shared';
import type { ActivityDto, DashboardDto, GstRegisterRowDto, GstSummaryRowDto, HsnSummaryRowDto, Paged } from '../../shared';

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

export async function activity(ctx: TenantContext, q: { page: number; pageSize: number; from?: Date; to?: Date; module?: string; action?: (typeof ACTIVITY_ACTIONS)[number]; userId?: number }): Promise<Paged<ActivityDto>> {
  const sdb = scopedDb(ctx);
  const branches = branchFilter(ctx);
  const where: any = {
    branchId: { in: branches },
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

export async function gstRegister(ctx: TenantContext, q: { page: number; pageSize: number; from?: Date; to?: Date; kind: 'SELL' | 'PURCHASE' }): Promise<Paged<GstRegisterRowDto>> {
  const sdb = scopedDb(ctx);
  const where: any = { kind: q.kind, billType: 'GST', status: 'ACTIVE', branchId: { in: branchFilter(ctx) }, ...gstDateWhere(q.from, q.to) };
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
    if (q.groupBy === 'QUARTER') return `${yy}-Q${Math.floor((mm - 1) / 3) + 1}`;
    const fy = mm >= 4 ? yy : yy - 1; // FY Apr–Mar
    return `FY${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
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
