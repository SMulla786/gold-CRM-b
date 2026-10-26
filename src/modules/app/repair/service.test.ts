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

  it('two concurrent deliveries → one wins, one 409, money posted once (BUG-10)', async () => {
    const s = await setup();
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id, labourCharge: 1000, otherCharge: 0, advanceCash: 0 }) as any);
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_REVIEW' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'READY', finalWeight: 12, remarks: 'ok' });
    const del = () => repair.deliverRepair(s.ctx, t.id, { addedFine: 0, addedRate: 0, cash: 1000, online: 0 } as any);
    const results = await Promise.allSettled([del(), del()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as any).status === 409)).toHaveLength(1);
    const moneyIn = await db.ledgerEntry.findMany({ where: { source: 'REPAIR', asset: 'MONEY', direction: 'IN' } });
    expect(moneyIn.reduce((a, r) => a + Number(r.amount), 0)).toBe(1000); // delivery charged once, not twice
  });

  it('list q matches ticket no, party name/mobile, description', async () => {
    const s = await setup();
    const a = await repair.createRepair(s.ctx, base({ partyId: s.customer.id, description: 'Bent prong' }) as any);
    const other = await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Zed', mobile: '9222222222', countryCode: '+91' } });
    await repair.createRepair(s.ctx, base({ partyId: other.id, description: 'Loose clasp' }) as any);
    const page = { page: 1, pageSize: 20 };
    expect((await repair.listRepairs(s.ctx, { ...page, q: 'cust' })).items.map((t) => t.id)).toEqual([a.id]);
    expect((await repair.listRepairs(s.ctx, { ...page, q: '922222' })).total).toBe(1);
    expect((await repair.listRepairs(s.ctx, { ...page, q: '9222222222' })).total).toBe(1); // full 10-digit mobile: no Int4 overflow
    expect((await repair.listRepairs(s.ctx, { ...page, q: '99999999999999' })).total).toBe(0);
    expect((await repair.listRepairs(s.ctx, { ...page, q: 'prong' })).items.map((t) => t.id)).toEqual([a.id]);
    expect((await repair.listRepairs(s.ctx, { ...page, q: `#${a.ticketNo}` })).items.map((t) => t.id)).toContain(a.id);
    expect((await repair.listRepairs(s.ctx, { ...page, q: 'nomatch-xyz' })).total).toBe(0);
  });

  it('karigar: assign on the way forward, reassign in place; non-karigar / foreign → rejected', async () => {
    const s = await setup();
    const k1 = await db.party.create({ data: { businessId: s.business.id, type: 'KARIGAR', name: 'K1', mobile: '9333333331', countryCode: '+91' } });
    const k2 = await db.party.create({ data: { businessId: s.business.id, type: 'KARIGAR', name: 'K2', mobile: '9333333332', countryCode: '+91' } });
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id }) as any);
    expect((await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS', karigarId: k1.id })).karigar?.id).toBe(k1.id);
    const re = await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS', karigarId: k2.id });
    expect(re.status).toBe('IN_PROGRESS');
    expect(re.karigar?.id).toBe(k2.id);
    await expect(repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' })).rejects.toMatchObject({ status: 409 }); // same status, nothing to change
    await expect(repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS', karigarId: s.customer.id })).rejects.toMatchObject({ status: 400 });
    const other = await createBusiness({ name: 'B' });
    const bK = await db.party.create({ data: { businessId: other.business.id, type: 'KARIGAR', name: 'BK', mobile: '9444444444', countryCode: '+91' } });
    await expect(repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS', karigarId: bK.id })).rejects.toMatchObject({ status: 404 });
  });

  it('cross-tenant party → 404', async () => {
    const s = await setup();
    const other = await createBusiness({ name: 'B' });
    const bParty = await db.party.create({ data: { businessId: other.business.id, type: 'CUSTOMER', name: 'B', mobile: '9111111111', countryCode: '+91' } });
    await expect(repair.createRepair(s.ctx, base({ partyId: bParty.id }) as any)).rejects.toMatchObject({ status: 404 });
  });

  it('TASK-97: deliver with OTHER added metal → value billed, no metal ledger row; DTO shows OTHER + settlement', async () => {
    const s = await setup();
    const t = await repair.createRepair(s.ctx, base({ partyId: s.customer.id, labourCharge: 1000, otherCharge: 0, advanceCash: 0, purity: 91.6, subCategory: 'Clasp' }) as any);
    expect(t.purity).toBe('91.60');
    expect(t.subCategory).toBe('Clasp');
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_REVIEW' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'READY', finalWeight: 12, remarks: 'ok' });
    // 1000 + (1 g × 500) = 1500; − 200 cash − 300 online = 1000
    const d = await repair.deliverRepair(s.ctx, t.id, { addedMetal: 'OTHER', addedFine: 1, addedRate: 500, cash: 200, online: 300, bankAccountId: s.bank.id } as any);
    expect(Number(d.balance)).toBe(1000);
    expect(d.addedMetal).toBe('OTHER');
    expect(d.addedFine).toBe('1.000');
    expect(d.deliveryCash).toBe('200.00');
    expect(d.deliveryBank?.id).toBe(s.bank.id);
    expect(await db.ledgerEntry.count({ where: { source: 'REPAIR', asset: { in: ['GOLD', 'SILVER'] } } })).toBe(0);
    expect(await sumUdhar(s.customer.id)).toBe(1000);
  });

  it('TASK-97: list filters by metal and created date range', async () => {
    const s = await setup();
    const g = await repair.createRepair(s.ctx, base({ partyId: s.customer.id }) as any);
    await repair.createRepair(s.ctx, base({ partyId: s.customer.id, metal: 'SILVER' }) as any);
    const page = { page: 1, pageSize: 20 };
    expect((await repair.listRepairs(s.ctx, { ...page, metal: 'GOLD' })).items.map((t) => t.id)).toEqual([g.id]);
    const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
    expect((await repair.listRepairs(s.ctx, { ...page, from: today, to: today })).total).toBe(2);
    expect((await repair.listRepairs(s.ctx, { ...page, to: new Date(today.getTime() - 86_400_000) })).total).toBe(0);
  });

  it('TASK-97: consumables CRUD + adjust (never below zero) + status', async () => {
    const s = await setup();
    const c = await repair.createConsumable(s.ctx, { name: 'Solder wire', unit: 'g', currentStock: 5, minLevel: 2, isActive: true });
    expect(c.status).toBe('OK');
    expect((await repair.listConsumables(s.ctx)).map((x) => x.id)).toEqual([c.id]);
    expect((await repair.updateConsumable(s.ctx, c.id, { minLevel: 6, category: 'Metal' })).status).toBe('LOW');
    expect((await repair.adjustConsumable(s.ctx, c.id, { delta: -5, reason: 'used' })).status).toBe('OUT');
    await expect(repair.adjustConsumable(s.ctx, c.id, { delta: -1 })).rejects.toMatchObject({ status: 409 });
    expect((await repair.adjustConsumable(s.ctx, c.id, { delta: 10 })).currentStock).toBe('10.000');
    const other = await createBusiness({ name: 'B' });
    await expect(repair.updateConsumable(ctxFor(other.business.id, other.root.id), c.id, { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });
});
