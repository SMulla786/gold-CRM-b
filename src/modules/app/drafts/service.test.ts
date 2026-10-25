import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as inv from '../inventory';
import * as drafts from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number, userId = 1): TenantContext => ({
  userId, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  await db.metalRate.create({ data: { businessId: business.id, metal: 'GOLD', branchId: root.id, rateUnit: 'GRAM_10', karatCode: '22K', sellRate: 60000, buyRate: 59000, effectiveAt: new Date() } });
  const ctx = ctxFor(business.id, root.id);
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const itemName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  return { business, root, ctx, itemName: itemName! };
}

async function newItem(ctx: TenantContext, itemNameId: number, gross = 10): Promise<number> {
  const e = await inv.createStockEntry(ctx, { stockClass: 'GOLD', method: 'TAG', rows: [{ itemNameId, karatCode: '22K', gross, pcs: 1, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0 }] });
  return e.items[0]!.id;
}

describe('showroom drafts', () => {
  it('create from AVAILABLE items → PENDING, numbered, estimated, expires end of today', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const b = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a, b], customerName: 'Walk-in', requestedDiscount: 500, requestedDiscountUnit: 'FIXED' });
    expect(d.status).toBe('PENDING');
    expect(d.draftNo).toBe(1);
    expect(d.items.map((i) => i.stockItemId).sort()).toEqual([a, b].sort());
    expect(d.items.every((i) => i.available)).toBe(true);
    expect(Number(d.estTotal)).toBeGreaterThan(0); // 2 × 10g @ 60000/10g, before discount
    expect(new Date(d.expiresAt).getTime()).toBeGreaterThan(Date.now()); // later today
  });

  it('create with an unavailable (SOLD) item → 409', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    await db.stockItem.update({ where: { id: a }, data: { status: 'SOLD' } });
    await expect(drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' })).rejects.toMatchObject({ status: 409 });
  });

  it('approve (only when PENDING) sets the approved discount; a second decision → 409', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    const approved = await drafts.decideDraft(s.ctx, d.id, { decision: 'APPROVE', approvedDiscount: 300, approvedDiscountUnit: 'FIXED' });
    expect(approved.status).toBe('APPROVED');
    expect(Number(approved.approvedDiscount)).toBe(300);
    expect(approved.decidedAt).not.toBeNull(); // decision stamped
    expect(approved.decidedBy).toBeDefined();
    await expect(drafts.decideDraft(s.ctx, d.id, { decision: 'REJECT', rejectionReason: 'too late' })).rejects.toMatchObject({ status: 409 });
  });

  it('reject records the reason', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    const r = await drafts.decideDraft(s.ctx, d.id, { decision: 'REJECT', rejectionReason: 'discount too high' });
    expect(r.status).toBe('REJECTED');
    expect(r.rejectionReason).toBe('discount too high');
  });

  it('by-no: 409 until APPROVED, then returns the draft', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    await expect(drafts.getDraftByNo(s.ctx, d.draftNo)).rejects.toMatchObject({ status: 409 }); // PENDING
    await drafts.decideDraft(s.ctx, d.id, { decision: 'APPROVE', approvedDiscount: 0, approvedDiscountUnit: 'FIXED' });
    const got = await drafts.getDraftByNo(s.ctx, d.draftNo);
    expect(got.id).toBe(d.id);
  });

  it('EXPIRED is derived on read; an expired approved draft cannot be billed (by-no 409)', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    await drafts.decideDraft(s.ctx, d.id, { decision: 'APPROVE', approvedDiscount: 0, approvedDiscountUnit: 'FIXED' });
    await db.salesDraft.update({ where: { id: d.id }, data: { expiresAt: new Date(Date.now() - 1000) } }); // expired a second ago
    expect((await drafts.getDraft(s.ctx, d.id)).status).toBe('EXPIRED');
    await expect(drafts.getDraftByNo(s.ctx, d.draftNo)).rejects.toMatchObject({ status: 409 });
  });

  it('cancel a PENDING draft → CANCELLED; cancelling a REJECTED one → 409', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    expect((await drafts.cancelDraft(s.ctx, d.id)).status).toBe('CANCELLED');

    const d2 = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'Y', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    await drafts.decideDraft(s.ctx, d2.id, { decision: 'REJECT', rejectionReason: 'no' });
    await expect(drafts.cancelDraft(s.ctx, d2.id)).rejects.toMatchObject({ status: 409 });
  });

  it('list filters by status and derives EXPIRED', async () => {
    const s = await setup();
    const a = await newItem(s.ctx, s.itemName.id);
    const d = await drafts.createDraft(s.ctx, { stockItemIds: [a], customerName: 'X', requestedDiscount: 0, requestedDiscountUnit: 'FIXED' });
    await db.salesDraft.update({ where: { id: d.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await drafts.listDrafts(s.ctx, { page: 1, pageSize: 20, status: 'EXPIRED' });
    expect(expired.total).toBe(1);
    expect(expired.items[0]!.status).toBe('EXPIRED');
  });
});
