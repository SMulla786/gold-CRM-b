import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import * as repair from './service';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, ctx, customer, bank };
}
const sumUdhar = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId }, select: { amount: true } })).reduce((a, r) => a + Number(r.amount), 0);

const base = (over: Record<string, unknown> = {}) => ({ partyId: 0, metal: 'GOLD', category: 'Chain', description: 'Broken clasp', pcs: 1, gross: 12, expectedDate: new Date(), priority: 'NORMAL', labourCharge: 1000, otherCharge: 200, advanceCash: 500, advanceOnline: 0, ...over });

describe('repair', () => {
  it('create with an advance → REPAIR money IN, status RECEIVED', async () => {
    const s = await setup();
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id }) as any);
    expect(t.status).toBe('RECEIVED');
    expect(Number(t.advance)).toBe(500);
    const led = await db.ledgerEntry.findMany({ where: { source: 'REPAIR', asset: 'MONEY' } });
    expect(led).toHaveLength(1);
    expect(led[0]!.direction).toBe('IN');
    expect(Number(led[0]!.amount)).toBe(500);
  });

  it('status moves forward only; IN_REVIEW→READY needs final weight + remarks', async () => {
    const s = await setup();
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id }) as any);
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_REVIEW' });
    await expect(repair.updateRepairStatus(s.ctx, t.id, { status: 'READY' })).rejects.toMatchObject({ status: 400 }); // missing finalWeight/remarks
    const ready = await repair.updateRepairStatus(s.ctx, t.id, { status: 'READY', finalWeight: 11.8, remarks: 'polished' });
    expect(ready.status).toBe('READY');
    await expect(repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ status: 409 }); // no going back
  });

  it('deliver with solder → MONEY IN + shop GOLD OUT, balance to party udhar', async () => {
    const s = await setup();
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id, labourCharge: 1000, otherCharge: 200, advanceCash: 500 }) as any);
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_REVIEW' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'READY', finalWeight: 14, remarks: 'added solder' });
    // charges = 1000 + 200 + (2g × 6000/g = 12000) = 13200; − advance 500 − delivery 3000 = 9700
    const delivered = await repair.deliverRepair(s.ctx, t.id, { addedMetal: 'GOLD', addedFine: 2, addedRate: 6000, cash: 3000, online: 0 } as any);
    expect(delivered.status).toBe('DELIVERED');
    expect(Number(delivered.balance)).toBe(9700);

    const gold = await db.ledgerEntry.findMany({ where: { source: 'REPAIR', asset: 'GOLD' } });
    expect(gold[0]!.direction).toBe('OUT');
    expect(Number(gold[0]!.fine)).toBe(2);
    const moneyIn = await db.ledgerEntry.findMany({ where: { source: 'REPAIR', asset: 'MONEY', direction: 'IN' } });
    expect(moneyIn.reduce((a, r) => a + Number(r.amount), 0)).toBe(3500); // 500 advance + 3000 delivery
    expect(await sumUdhar(s.customer.id)).toBe(9700); // party owes the balance
  });

  it('only a READY ticket can be delivered (409)', async () => {
    const s = await setup();
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id }) as any);
    await expect(repair.deliverRepair(s.ctx, t.id, { addedFine: 0, addedRate: 0, cash: 0, online: 0 } as any)).rejects.toMatchObject({ status: 409 });
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const other = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: other.business.id, type: 'CUSTOMER', name: 'B', mobile: '9111111111', countryCode: '+91' } });
    await expect(repair.createRepair(s.ctx, base({ partyId: bParty.id }) as any)).rejects.toMatchObject({ status: 404 });
  });
});
