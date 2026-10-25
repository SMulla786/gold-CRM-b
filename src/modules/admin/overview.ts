import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { scopedDb } from '../../lib/db';
import { businessDate } from '../../lib/ledger';
import type { TenantContext } from '../../middleware/context';
import { currentRates } from '../app/service';
import type { AdminMetalMoneyDto, AdminOverviewDto, AdminOverviewRowDto } from '../../shared';

// TASK-88: consolidated per-branch + business overview over the caller's accessible subtree.
// Every figure is a SQL aggregate/groupBy through scopedDb (or one branch-scoped raw query) — no rows summed in JS.
const D = (v: unknown) => new Prisma.Decimal((v ?? 0) as Prisma.Decimal.Value);
const money = (d: Prisma.Decimal) => d.toFixed(2);
const wt = (d: Prisma.Decimal) => d.toFixed(3);

export async function adminOverview(ctx: TenantContext): Promise<AdminOverviewDto> {
  const sdb = scopedDb(ctx);
  const branches = ctx.branchIds; // whole accessible subtree (branch-admin sees only its own; cross-tenant excluded by scopedDb)
  const today = businessDate();
  const scope = Prisma.sql`"businessId" = ${ctx.businessId!} AND "branchId" IN (${Prisma.join(branches)})`;

  const [brs, stockRows, salesRows, userRows, udharRows, bizUdhar, rates] = await Promise.all([
    sdb.branch.findMany({ where: { id: { in: branches } }, select: { id: true, name: true, path: true, depth: true, isAdminNode: true }, orderBy: { path: 'asc' } }),
    sdb.stockItem.groupBy({ by: ['branchId', 'stockClass'], where: { status: 'AVAILABLE', branchId: { in: branches } }, _count: { _all: true }, _sum: { fine: true, purchaseCost: true } }),
    sdb.bill.groupBy({ by: ['branchId'], where: { kind: 'SELL', status: 'ACTIVE', branchId: { in: branches }, billDate: today }, _sum: { final: true } }),
    // User is business-scoped (not branch-filtered) by scopedDb → the branchId filter here is required.
    sdb.user.groupBy({ by: ['branchId'], where: { status: { not: 'DELETED' }, branchId: { in: branches } }, _count: { _all: true } }),
    // per-branch signed attribution (Σ of all udhar movements posted at the branch; reversals net out)
    sdb.udharEntry.groupBy({ by: ['branchId'], where: { branchId: { in: branches } }, _sum: { amount: true, gold: true, silver: true } }),
    // true business receivable = Σ positive party balances (party balances are business-wide → not the sum of the per-branch rows)
    prisma.$queryRaw<{ amount: Prisma.Decimal; gold: Prisma.Decimal; silver: Prisma.Decimal }[]>(Prisma.sql`
      SELECT
        (SELECT COALESCE(SUM(v),0)::numeric FROM (SELECT SUM(amount) v FROM "UdharEntry" WHERE ${scope} GROUP BY "partyId") a WHERE v > 0) AS amount,
        (SELECT COALESCE(SUM(v),0)::numeric FROM (SELECT SUM(gold)   v FROM "UdharEntry" WHERE ${scope} GROUP BY "partyId") a WHERE v > 0) AS gold,
        (SELECT COALESCE(SUM(v),0)::numeric FROM (SELECT SUM(silver) v FROM "UdharEntry" WHERE ${scope} GROUP BY "partyId") a WHERE v > 0) AS silver`),
    currentRates({ ...ctx, activeBranchId: null }), // null active branch → business-level rates (branch 0)
  ]);

  const stockByBranch = new Map<number, { goldFine: Prisma.Decimal; silverFine: Prisma.Decimal; items: number; value: Prisma.Decimal }>();
  for (const r of stockRows) {
    const e = stockByBranch.get(r.branchId) ?? { goldFine: new Prisma.Decimal(0), silverFine: new Prisma.Decimal(0), items: 0, value: new Prisma.Decimal(0) };
    if (r.stockClass === 'GOLD') e.goldFine = e.goldFine.plus(D(r._sum.fine));
    else if (r.stockClass === 'SILVER') e.silverFine = e.silverFine.plus(D(r._sum.fine));
    e.items += r._count._all;
    e.value = e.value.plus(D(r._sum.purchaseCost));
    stockByBranch.set(r.branchId, e);
  }
  const salesByBranch = new Map(salesRows.map((r) => [r.branchId, D(r._sum.final)]));
  const userByBranch = new Map(userRows.map((r) => [r.branchId, r._count._all]));
  const udharByBranch = new Map(udharRows.map((r) => [r.branchId, r._sum]));

  const rows: AdminOverviewRowDto[] = brs.map((b) => {
    const s = stockByBranch.get(b.id);
    const u = udharByBranch.get(b.id);
    return {
      branch: { id: b.id, name: b.name, path: b.path, depth: b.depth, isAdminNode: b.isAdminNode },
      stock: { goldFine: wt(s?.goldFine ?? new Prisma.Decimal(0)), silverFine: wt(s?.silverFine ?? new Prisma.Decimal(0)), items: s?.items ?? 0, value: money(s?.value ?? new Prisma.Decimal(0)) },
      salesToday: money(salesByBranch.get(b.id) ?? new Prisma.Decimal(0)),
      udhariReceivable: { amount: money(D(u?.amount)), gold: wt(D(u?.gold)), silver: wt(D(u?.silver)) },
      userCount: userByBranch.get(b.id) ?? 0,
    };
  });

  // totals: stock/sales/users reconcile with the rows above; receivable is the true positive-only business figure.
  const totStock = rows.reduce(
    (a, r) => ({ goldFine: a.goldFine.plus(D(r.stock.goldFine)), silverFine: a.silverFine.plus(D(r.stock.silverFine)), items: a.items + r.stock.items, value: a.value.plus(D(r.stock.value)) }),
    { goldFine: new Prisma.Decimal(0), silverFine: new Prisma.Decimal(0), items: 0, value: new Prisma.Decimal(0) },
  );
  const bizReceivable: AdminMetalMoneyDto = { amount: money(D(bizUdhar[0]?.amount)), gold: wt(D(bizUdhar[0]?.gold)), silver: wt(D(bizUdhar[0]?.silver)) };

  return {
    branches: rows,
    totals: {
      stock: { goldFine: wt(totStock.goldFine), silverFine: wt(totStock.silverFine), items: totStock.items, value: money(totStock.value) },
      salesToday: money(rows.reduce((a, r) => a.plus(D(r.salesToday)), new Prisma.Decimal(0))),
      udhariReceivable: bizReceivable,
      userCount: rows.reduce((a, r) => a + r.userCount, 0),
    },
    rates,
  };
}
