import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { repairBody, repairDeliverBody } from '../../../shared';
import * as repair from './service';
import type { TenantContext } from '../../../middleware/context';

/** REP-02: the Repair Ledger and its export (every filtered ticket via paging), each ticket's money reconciling with the
 *  ledger + udhar it posted, QA return-to-bench round trip, and consumables across branches / concurrent taps. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['repair'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, customer, bank, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;

const create = (s: S, o: Record<string, unknown> = {}) => repair.createRepair(s.ctx, repairBody.parse({
  partyId: s.customer.id, metal: 'GOLD', category: 'Chain', description: 'Broken clasp', pcs: 1, gross: 12, expectedDate: new Date(), priority: 'NORMAL',
  labourCharge: 1000, otherCharge: 200, advanceCash: 500, advanceOnline: 0, ...o,
}) as Parameters<typeof repair.createRepair>[1]);
const toReady = async (s: S, id: number) => {
  for (const status of ['IN_PROGRESS', 'IN_REVIEW'] as const) await repair.updateRepairStatus(s.ctx, id, { status });
  return repair.updateRepairStatus(s.ctx, id, { status: 'READY', finalWeight: 12.1, remarks: 'Done' });
};
const deliver = (s: S, id: number, o: Record<string, unknown> = {}) => repair.deliverRepair(s.ctx, id, repairDeliverBody.parse(o) as Parameters<typeof repair.deliverRepair>[2]);
/** what one ticket posted: Σ REPAIR money IN and its udhar balance */
async function posted(id: number) {
  const money = await db.ledgerEntry.findMany({ where: { source: 'REPAIR', sourceId: String(id), asset: 'MONEY' } });
  const udhar = await db.udharEntry.findMany({ where: { source: 'REPAIR', sourceId: String(id) } });
  const sum = (rows: { amount: Prisma.Decimal | null }[]) => rows.reduce((a, r) => a.plus(r.amount ?? 0), new Prisma.Decimal(0)).toFixed(2);
  return { moneyIn: sum(money.filter((r) => r.direction === 'IN')), udhar: sum(udhar) };
}

describe('repair ledger + export (REP-02)', () => {
  it('export = every filtered ticket: pages concatenate to the full list, newest first; the status filter narrows it', async () => {
    const s = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(s, { advanceCash: 0 })).id);
    await toReady(s, ids[1]!);
    await toReady(s, ids[3]!);

    const pageAll = async (q: Record<string, unknown>) => {
      const out: number[] = [];
      for (let page = 1; ; page++) {
        const r = await repair.listRepairs(s.ctx, { page, pageSize: 2, ...q });
        out.push(...r.items.map((x) => x.id));
        if (r.items.length === 0 || out.length >= r.total) return { ids: out, total: r.total };
      }
    };
    expect(await pageAll({})).toEqual({ ids: [...ids].reverse(), total: 5 });
    expect(await pageAll({ status: 'READY' })).toEqual({ ids: [ids[3], ids[1]], total: 2 });
    expect(await pageAll({ status: 'DELIVERED' })).toEqual({ ids: [], total: 0 });
  });

  it('each ticket reconciles: money posted + udhar balance = labour + other + added metal; the DTO advance/balance match', async () => {
    const s = await setup();
    // A: part paid on delivery → party owes the rest
    const a = await create(s, { advanceCash: 300, advanceOnline: 200, advanceBankId: s.bank.id });
    await toReady(s, a.id);
    const da = await deliver(s, a.id, { cash: 400 });
    expect([da.advance, da.balance]).toEqual(['500.00', '300.00']);
    expect(await posted(a.id)).toEqual({ moneyIn: '900.00', udhar: '300.00' });

    // B: paid exactly → no udhar row at all
    const b = await create(s);
    await toReady(s, b.id);
    expect((await deliver(s, b.id, { cash: 400, online: 300, bankAccountId: s.bank.id })).balance).toBe('0.00');
    expect(await posted(b.id)).toEqual({ moneyIn: '1200.00', udhar: '0.00' });
    expect(await db.udharEntry.count({ where: { source: 'REPAIR', sourceId: String(b.id) } })).toBe(0);

    // C: overpaid → negative udhar (the shop owes the customer)
    const c = await create(s);
    await toReady(s, c.id);
    expect((await deliver(s, c.id, { cash: 1000 })).balance).toBe('-300.00');
    expect(await posted(c.id)).toEqual({ moneyIn: '1500.00', udhar: '-300.00' });

    // D: solder at an odd rate — value 0.333 g × 6543.21 = 2178.88893; DTO, udhar and the gold row's value agree to the paisa
    const d = await create(s, { advanceCash: 0 });
    await toReady(s, d.id);
    const dd = await deliver(s, d.id, { addedMetal: 'GOLD', addedKaratCode: '22K', addedFine: 0.333, addedRate: 6543.21 });
    expect(dd.balance).toBe('3378.89'); // 1200 + 2178.89
    expect(await posted(d.id)).toEqual({ moneyIn: '0.00', udhar: '3378.89' });
    const gold = await db.ledgerEntry.findFirstOrThrow({ where: { source: 'REPAIR', sourceId: String(d.id), asset: 'GOLD' } });
    expect([gold.direction, Number(gold.fine), Number(gold.amount)]).toEqual(['OUT', 0.333, 2178.89]);
  });

  it('a cancelled ticket keeps its advance: no refund row is posted and the DTO still shows the unpaid charges', async () => {
    // pins current behaviour (owner question: should cancel refund the advance or credit the customer?)
    const s = await setup();
    const t = await create(s);
    const c = await repair.updateRepairStatus(s.ctx, t.id, { status: 'CANCELLED' });
    expect([c.status, c.advance, c.balance]).toEqual(['CANCELLED', '500.00', '700.00']);
    expect(await posted(t.id)).toEqual({ moneyIn: '500.00', udhar: '0.00' });
    expect(await db.ledgerEntry.count({ where: { source: 'REPAIR', sourceId: String(t.id), direction: 'OUT' } })).toBe(0);
    await expect(deliver(s, t.id, { cash: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('QA return to bench round trip: back to IN_PROGRESS, notes accumulate, then READY and deliver as normal; each return is logged', async () => {
    const s = await setup();
    const t = await create(s);
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_PROGRESS' });
    for (const note of ['solder visible', 'clasp loose']) {
      await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_REVIEW' });
      expect((await repair.rejectRepair(s.ctx, t.id, { remarks: note })).status).toBe('IN_PROGRESS');
    }
    expect((await repair.getRepair(s.ctx, t.id)).remarks).toBe('QA returned: solder visible; QA returned: clasp loose');
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'IN_REVIEW' });
    await repair.updateRepairStatus(s.ctx, t.id, { status: 'READY', finalWeight: 12, remarks: 'Fixed' });
    expect((await deliver(s, t.id, { cash: 700 })).status).toBe('DELIVERED');
    await expect(repair.rejectRepair(s.ctx, t.id, { remarks: 'late' })).rejects.toMatchObject({ status: 409 });
    const logs = await db.activityLog.findMany({ where: { entity: 'RepairTicket', entityId: String(t.id), summary: { contains: 'returned to bench' } } });
    expect(logs.map((l) => l.summary.split(': ')[1])).toEqual(['solder visible', 'clasp loose']);
  });

  it('consumables: one branch never sees or adjusts another\'s; the all-branches view lists both; concurrent take-outs never go below zero', async () => {
    const s = await setup();
    const branch2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2', isAdminNode: false });
    const c2 = ctxFor(s.business.id, branch2.id);
    const wire = await repair.createConsumable(s.ctx, { name: 'Solder wire', unit: 'g', currentStock: 5, minLevel: 1, isActive: true });
    const flux = await repair.createConsumable(c2, { name: 'Flux', unit: 'ml', currentStock: 1, minLevel: 0, isActive: true });

    expect((await repair.listConsumables(s.ctx)).map((x) => x.name)).toEqual(['Solder wire']);
    expect((await repair.listConsumables(c2)).map((x) => x.name)).toEqual(['Flux']);
    await expect(repair.adjustConsumable(c2, wire.id, { delta: -1 })).rejects.toMatchObject({ status: 404 });
    await expect(repair.updateConsumable(s.ctx, flux.id, { isActive: false })).rejects.toMatchObject({ status: 404 });
    const both = { ...s.ctx, activeBranchId: null, branchIds: [s.root.id, branch2.id] };
    expect((await repair.listConsumables(both)).map((x) => x.name)).toEqual(['Flux', 'Solder wire']);

    const r = await Promise.allSettled([repair.adjustConsumable(s.ctx, wire.id, { delta: -3 }), repair.adjustConsumable(s.ctx, wire.id, { delta: -3 })]);
    expect(r.filter((x) => x.status === 'rejected' && (x.reason as { status?: number }).status === 409)).toHaveLength(1);
    expect((await repair.listConsumables(s.ctx))[0]).toMatchObject({ currentStock: '2.000', status: 'OK' });
    await repair.adjustConsumable(s.ctx, wire.id, { delta: 0.1 });
    expect((await repair.adjustConsumable(s.ctx, wire.id, { delta: 0.2 })).currentStock).toBe('2.300'); // decimal column, no float drift
  });
});
