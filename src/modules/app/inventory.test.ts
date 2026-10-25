import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as inv from './inventory';
import type { TenantContext } from '../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchId,
  branchIds: [branchId],
  activeBranchId: branchId,
  readOnly: false,
  modules: ['inventory', 'settings', 'dashboard'],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  return { business, root, ctx, group: group!, itemName };
}
const row = (over: Record<string, unknown>) => ({ pcs: 1, gross: 10, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0, ...over });

describe('stock entry + ledger core', () => {
  it('auto-tags, computes fine, and posts an IN ledger row', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K', purchaseCost: 50000 })] });
    expect(entry.entryNo).toBe(1);
    const item = entry.items[0]!;
    expect(item.tagNo).toBe('GR0001');
    expect(Number(item.fine)).toBeCloseTo(9.167, 3); // 10 g × 91.67%
    const led = await db.ledgerEntry.findMany({ where: { source: 'STOCK_INSERT', sourceId: String(item.id) } });
    expect(led).toHaveLength(1);
    expect(led[0]!.asset).toBe('GOLD');
    expect(led[0]!.direction).toBe('IN');
    expect(Number(led[0]!.fine)).toBeCloseTo(9.167, 3);
  });

  it('allocates sequential tag numbers within an entry', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' }), row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    expect(entry.items.map((i) => i.tagNo)).toEqual(['GR0001', 'GR0002']);
  });

  it('edit reverses the old ledger rows and posts new ones', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const id = entry.items[0]!.id;
    await inv.updateStock(s.ctx, id, { gross: 20 });
    const led = await db.ledgerEntry.findMany({ where: { source: 'STOCK_INSERT', sourceId: String(id) }, orderBy: { id: 'asc' } });
    expect(led).toHaveLength(3); // original IN, reversal OUT, new IN
    const active = led.filter((r) => r.reversalOfId == null && !led.some((x) => x.reversalOfId === r.id));
    expect(active).toHaveLength(1);
    expect(Number(active[0]!.fine)).toBeCloseTo(18.334, 3); // 20 g × 91.67%
  });

  it('delete sets DELETED and reverses the ledger', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const id = entry.items[0]!.id;
    await inv.deleteStock(s.ctx, id);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id } })).status).toBe('DELETED');
    const led = await db.ledgerEntry.findMany({ where: { source: 'STOCK_INSERT', sourceId: String(id) } });
    expect(led).toHaveLength(2); // IN + reversal OUT
    expect(led.some((r) => r.reversalOfId != null && r.direction === 'OUT')).toBe(true);
  });

  it('summary totals AVAILABLE stock by class', async () => {
    const s = await setup();
    await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' }), row({ itemNameId: s.itemName.id, karatCode: '22K', gross: 5 })] });
    const summary = await inv.stockSummary(s.ctx);
    const gold = summary.find((x) => x.stockClass === 'GOLD')!;
    expect(gold.items).toBe(2);
    expect(Number(gold.gross)).toBeCloseTo(15, 3);
  });
});

describe('TASK-16b additions', () => {
  it('H1 updateItemName rejects a cross-tenant groupId -> 404', async () => {
    const s = await setup();
    const b = await createBusiness({ name: 'B' });
    const bGroup = await db.itemGroup.create({ data: { businessId: b.business.id, stockClass: 'GOLD', name: 'B-Rings', gstRate: 3 } });
    await expect(inv.updateItemName(s.ctx, s.itemName.id, { groupId: bGroup.id })).rejects.toMatchObject({ status: 404 });
  });

  it('H2 updateItemGroup rejects a cross-tenant jewelleryTypeId -> 404', async () => {
    const s = await setup();
    const b = await createBusiness({ name: 'B' });
    const bType = await db.jewelleryType.create({ data: { businessId: b.business.id, name: 'B-Type' } });
    await expect(inv.updateItemGroup(s.ctx, s.group.id, { jewelleryTypeId: bType.id })).rejects.toMatchObject({ status: 404 });
  });

  it('M1 CSV import: a non-numeric cell is a row error, not a 500', async () => {
    const s = await setup();
    const csv = ['item_name,gross', `${s.itemName.name},abc`].join('\n');
    const res = await inv.importStock(s.ctx, csv, { stockClass: 'GOLD', method: 'TAG', groupId: s.group.id, dryRun: true });
    expect(res.imported).toBe(0);
    expect(res.errors.some((e) => e.row === 2 && e.field === 'gross')).toBe(true);
  });
});
