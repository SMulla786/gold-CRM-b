import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import * as inv from './inventory';
import * as acc from './accounts';
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

describe('TASK-25 Phase 2b — bulk + transfer', () => {
  it('bulk edit recomputes fine + reverses/reposts ledger for every id; a non-AVAILABLE id -> 409', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' }), row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const ids = entry.items.map((i) => i.id);
    const res = await inv.bulkEditStock(s.ctx, ids, { gross: 20 });
    expect(res.updated).toBe(2);
    for (const id of ids) {
      expect(Number((await db.stockItem.findUniqueOrThrow({ where: { id } })).fine)).toBeCloseTo(18.334, 3); // 20 g × 91.67%
      expect(await db.ledgerEntry.count({ where: { source: 'STOCK_INSERT', sourceId: String(id) } })).toBe(3); // IN, reversal OUT, new IN
    }
    await inv.deleteStock(s.ctx, ids[0]!);
    await expect(inv.bulkEditStock(s.ctx, ids, { gross: 30 })).rejects.toMatchObject({ status: 409 });
  });

  it('bulk delete soft-deletes + reverses every id; a missing id -> 404', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const id = entry.items[0]!.id;
    await expect(inv.bulkDeleteStock(s.ctx, [id, 999999])).rejects.toMatchObject({ status: 404 });
    expect((await inv.bulkDeleteStock(s.ctx, [id])).updated).toBe(1);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id } })).status).toBe('DELETED');
    const led = await db.ledgerEntry.findMany({ where: { source: 'STOCK_INSERT', sourceId: String(id) } });
    expect(led.some((r) => r.reversalOfId != null && r.direction === 'OUT')).toBe(true);
  });

  it('stock transfer moves the item + posts OUT/IN, is visible from the destination, and guards both branches', async () => {
    const s = await setup();
    const b = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B' });
    const c = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'C' });
    const owner = { ...ctxFor(s.business.id, s.root.id), branchIds: [s.root.id, b.id] };
    const entry = await inv.createStockEntry(owner, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const itemId = entry.items[0]!.id;

    // c is outside owner's subtree -> 404
    await expect(inv.createStockTransfer(owner, { fromBranchId: s.root.id, toBranchId: c.id, stockItemIds: [itemId] })).rejects.toMatchObject({ status: 404 });

    const t = await inv.createStockTransfer(owner, { fromBranchId: s.root.id, toBranchId: b.id, stockItemIds: [itemId] });
    expect(t.transferNo).toBe(1);
    expect(t.items[0]!.branch.id).toBe(b.id);
    expect((await db.stockItem.findUniqueOrThrow({ where: { id: itemId } })).branchId).toBe(b.id);
    const led = await db.ledgerEntry.findMany({ where: { source: 'STOCK_TRANSFER', sourceId: String(t.id) } });
    expect(led.filter((r) => r.direction === 'OUT' && r.branchId === s.root.id)).toHaveLength(1);
    expect(led.filter((r) => r.direction === 'IN' && r.branchId === b.id)).toHaveLength(1);

    // a user who only covers the destination branch still sees the transfer (OR scope)
    const bUser = ctxFor(s.business.id, b.id);
    expect((await inv.getStockTransfer(bUser, t.id)).transferNo).toBe(1);
    expect((await inv.listStockTransfers(bUser, { page: 1, pageSize: 20 })).total).toBe(1);

    // the item now lives at b -> re-transfer from root is 409 (not in source)
    await expect(inv.createStockTransfer(owner, { fromBranchId: s.root.id, toBranchId: b.id, stockItemIds: [itemId] })).rejects.toMatchObject({ status: 409 });
  });
});

describe('TASK-25b — transferred-item edit/delete nets to zero; sold-item guard', () => {
  async function netFineByBranch(stockItemId: number): Promise<Map<number, number>> {
    const rows = await db.ledgerEntry.findMany({ where: { stockItemId }, select: { branchId: true, direction: true, fine: true } });
    const m = new Map<number, number>();
    for (const r of rows) m.set(r.branchId, (m.get(r.branchId) ?? 0) + (r.direction === 'IN' ? 1 : -1) * Number(r.fine));
    return m;
  }
  async function transferred() {
    const s = await setup();
    const b = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B' });
    const owner = { ...ctxFor(s.business.id, s.root.id), branchIds: [s.root.id, b.id] };
    const entry = await inv.createStockEntry(owner, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const itemId = entry.items[0]!.id;
    const t = await inv.createStockTransfer(owner, { fromBranchId: s.root.id, toBranchId: b.id, stockItemIds: [itemId] });
    return { s, b, owner, itemId, t };
  }

  it('delete after a transfer reverses every branch leg -> A=0, B=0', async () => {
    const { s, b, owner, itemId } = await transferred();
    await inv.deleteStock(owner, itemId);
    const net = await netFineByBranch(itemId);
    expect(net.get(s.root.id) ?? 0).toBeCloseTo(0, 3);
    expect(net.get(b.id) ?? 0).toBeCloseTo(0, 3);
  });

  it('edit after a transfer leaves source=0 and reposts the new weight at the destination', async () => {
    const { s, b, owner, itemId } = await transferred();
    await inv.updateStock(owner, itemId, { gross: 20 });
    const net = await netFineByBranch(itemId);
    expect(net.get(s.root.id) ?? 0).toBeCloseTo(0, 3);
    expect(net.get(b.id) ?? 0).toBeCloseTo(18.334, 3); // 20 g × 91.67%
  });

  it('transfer list gross is unchanged after the item is deleted (reversal rows excluded)', async () => {
    const { owner, itemId } = await transferred();
    const before = (await inv.listStockTransfers(owner, { page: 1, pageSize: 20 })).items[0]!.gross;
    expect(Number(before)).toBeCloseTo(10, 3);
    await inv.deleteStock(owner, itemId);
    expect((await inv.listStockTransfers(owner, { page: 1, pageSize: 20 })).items[0]!.gross).toBe(before);
  });

  it('an item on a sell bill cannot be edited or deleted (409)', async () => {
    const s = await setup();
    const entry = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    const itemId = entry.items[0]!.id;
    await db.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, txnDate: new Date(), asset: 'GOLD', direction: 'OUT', net: 10, fine: 9.167, source: 'SELL_BILL', sourceId: '1', stockItemId: itemId } });
    await expect(inv.updateStock(s.ctx, itemId, { gross: 20 })).rejects.toMatchObject({ status: 409 });
    await expect(inv.deleteStock(s.ctx, itemId)).rejects.toMatchObject({ status: 409 });
  });
});

describe('TASK-29 — /ledgers stockItemId filter', () => {
  it('returns only the movement rows of one stock item', async () => {
    const s = await setup();
    const e = await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' }), row({ itemNameId: s.itemName.id, karatCode: '22K', gross: 5 })] });
    const target = e.items[0]!;
    const page = await acc.getLedgerPage(s.ctx, { page: 1, pageSize: 20, asset: 'GOLD', stockItemId: target.id });
    expect(page.total).toBe(1);
    expect(page.items[0]!.item?.id).toBe(target.id);
  });
});

describe('TASK-98 — shortage pcs limits + item group delete', () => {
  it('flags SHORTAGE/WARNING by pcs when minPcs/maxPcs are set; weight rule unchanged when pcs limits are null', async () => {
    const s = await setup();
    // pcs-only limits: min 3, max 5
    const [pcsGroup] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Pcs Group'], gstRate: 3, minPcs: 3, maxPcs: 5 });
    const pcsName = await inv.createItemName(s.ctx, { groupId: pcsGroup!.id, name: 'Pcs Ring', method: 'TAG', tagPrefix: 'PR', tagDigits: 4 });
    const statusOf = async (id: number) => (await inv.shortage(s.ctx, {})).find((r) => r.id === id)!.status;
    const add = (n: number) => inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: Array.from({ length: n }, () => row({ itemNameId: pcsName.id, karatCode: '22K' })) });

    expect(await statusOf(pcsGroup!.id)).toBe('SHORTAGE'); // 0 < 3
    await add(3);
    expect(await statusOf(pcsGroup!.id)).toBe('WARNING'); // 3 < 3.6
    await add(1);
    expect(await statusOf(pcsGroup!.id)).toBe('OK'); // 4 within 3..5
    await add(2);
    expect(await statusOf(pcsGroup!.id)).toBe('WARNING'); // 6 > maxPcs 5 (overstock)

    // weight-only limits (pcs null): 10 g on hand vs min 5 g → OK, vs min 9 g → WARNING, vs min 20 g → SHORTAGE
    await inv.createStockEntry(s.ctx, { stockClass: 'GOLD', method: 'TAG', rows: [row({ itemNameId: s.itemName.id, karatCode: '22K' })] });
    await inv.updateItemGroup(s.ctx, s.group.id, { minWeight: 5 });
    expect(await statusOf(s.group.id)).toBe('OK');
    await inv.updateItemGroup(s.ctx, s.group.id, { minWeight: 9 });
    expect(await statusOf(s.group.id)).toBe('WARNING');
    await inv.updateItemGroup(s.ctx, s.group.id, { minWeight: 20 });
    expect(await statusOf(s.group.id)).toBe('SHORTAGE');

    // pure helper: worse of weight and pcs wins
    expect(inv.shortageStatus({ net: 100, pcs: 0, minWeight: 5, minPcs: 1, maxPcs: null })).toBe('SHORTAGE');
    expect(inv.shortageStatus({ net: 1, pcs: 10, minWeight: 5, minPcs: 1, maxPcs: null })).toBe('SHORTAGE');
    expect(inv.shortageStatus({ net: 1, pcs: 10, minWeight: null, minPcs: null, maxPcs: null })).toBe('OK');
  });

  it('deletes an unused group; 409 while an item name references it; 404 cross-tenant', async () => {
    const s = await setup();
    const [empty] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Empty'], gstRate: 3 });
    await inv.deleteItemGroup(s.ctx, empty!.id);
    expect(await db.itemGroup.findUnique({ where: { id: empty!.id } })).toBeNull();
    await expect(inv.deleteItemGroup(s.ctx, s.group.id)).rejects.toMatchObject({ status: 409 });
    const other = await createBusiness({ name: 'B' });
    await expect(inv.deleteItemGroup(ctxFor(other.business.id, other.root.id), s.group.id)).rejects.toMatchObject({ status: 404 });
  });
});
