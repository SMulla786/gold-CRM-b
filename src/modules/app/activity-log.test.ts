import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import type { ActivityAction } from '../../shared';
import type { TenantContext } from '../../middleware/context';
import { createIncomeExpense, deleteIncomeExpense, updateIncomeExpense } from './accounts';
import { createItemGroups, createItemName, createStockEntry, createStockTransfer, deleteStock, updateStock } from './inventory';

// TASK-34b: every mutating op in income/expense + inventory writes exactly one ActivityLog row.
const ctxFor = (businessId: number, branchIds: number[], activeBranchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchIds[0]!, branchIds, activeBranchId,
  readOnly: false, modules: [], limits: null, permissions: {}, impersonatorId: null,
});
const countLog = (businessId: number, module: string, action: ActivityAction) => db.activityLog.count({ where: { businessId, module, action } });

async function goldItemName(ctx: TenantContext) {
  const [group] = await createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const n = await createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'BOTH', tagPrefix: 'GR', tagDigits: 4 });
  return n.id;
}

describe('activity logging (TASK-34b)', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  it('income/expense create/edit/delete each write one row', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const dto = await createIncomeExpense(ctx, { type: 'INCOME', reason: 'Scrap sale', cash: 1000, online: 0, gold: 0, silver: 0 });
    await updateIncomeExpense(ctx, dto.id, { type: 'INCOME', reason: 'Scrap sale (fixed)', cash: 1200, online: 0, gold: 0, silver: 0 });
    await deleteIncomeExpense(ctx, dto.id);
    expect(await countLog(business.id, 'INCOME_EXPENSE', 'CREATED')).toBe(1);
    expect(await countLog(business.id, 'INCOME_EXPENSE', 'EDITED')).toBe(1);
    expect(await countLog(business.id, 'INCOME_EXPENSE', 'DELETED')).toBe(1);
  });

  it('stock entry/edit/delete each write one STOCK row', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const itemNameId = await goldItemName(ctx);
    const entry = await createStockEntry(ctx, { stockClass: 'GOLD', method: 'LOOSE', branchId: root.id, rows: [{ itemNameId, gross: 10, tunch: 91.67, pcs: 1 }, { itemNameId, gross: 5, tunch: 91.67, pcs: 1 }] });
    await updateStock(ctx, entry.items[0]!.id, { gross: 11 });
    await deleteStock(ctx, entry.items[1]!.id);
    expect(await countLog(business.id, 'STOCK', 'CREATED')).toBe(1); // one entry (any # of rows) = one activity row
    expect(await countLog(business.id, 'STOCK', 'EDITED')).toBe(1);
    expect(await countLog(business.id, 'STOCK', 'DELETED')).toBe(1);
  });

  it('stock transfer writes one STOCK_TRANSFER row', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const child = await createBranch({ businessId: business.id, parentId: root.id, name: 'Child' });
    const ctx = ctxFor(business.id, [root.id, child.id], root.id);
    const itemNameId = await goldItemName(ctx);
    const entry = await createStockEntry(ctx, { stockClass: 'GOLD', method: 'LOOSE', branchId: root.id, rows: [{ itemNameId, gross: 10, tunch: 91.67, pcs: 1 }] });
    await createStockTransfer(ctx, { fromBranchId: root.id, toBranchId: child.id, stockItemIds: [entry.items[0]!.id] });
    expect(await countLog(business.id, 'STOCK_TRANSFER', 'CREATED')).toBe(1);
  });
});
