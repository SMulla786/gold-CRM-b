import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { justBillBody } from '../../../shared';
import { closeDay } from '../daybook/service';
import * as jb from './service';
import type { TenantContext } from '../../../middleware/context';

/** TASK-98: Just Bill UDHAR_ADVANCE pay mode — post / delete to zero / DAY_CLOSED / over-balance 409 / no party 400. */

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
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, ctx, party };
}

/** one PCS line: final = ₹10,000 */
const bill = (o: Record<string, unknown>, payments: unknown[]) => justBillBody.parse({ ...o, items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 10000 }], payments });

const partyMoney = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);
const jbMoneyIn = async () => (await db.ledgerEntry.findMany({ where: { source: 'JUST_BILL', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
/** party credit of ₹amount (shop owes the party), as an earlier udhar receipt would leave it */
const giveAdvance = (s: Awaited<ReturnType<typeof setup>>, amount: number) =>
  db.udharEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, partyId: s.party.id, txnDate: new Date(), amount: -amount, gold: 0, silver: 0, source: 'UDHAR', sourceId: '999', createdById: 1 } });

describe('Just Bill UDHAR_ADVANCE pay mode', () => {
  it('post: uses the party credit, no MONEY ledger row; party nets to zero', async () => {
    const s = await setup();
    await giveAdvance(s, 4000);
    const b = await jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 4000, remark: 'adv' }, { mode: 'CASH', amount: 6000 }]));
    expect(Number(b.paid)).toBe(10000);
    expect(Number(b.balance)).toBe(0);
    expect(b.payments.map((p) => p.mode)).toEqual(['UDHAR_ADVANCE', 'CASH']);
    expect(b.payments[0]!.remark).toBe('adv');
    expect(await jbMoneyIn()).toBe(6000); // only the cash moved
    expect(await db.ledgerEntry.count({ where: { source: 'JUST_BILL', sourceId: `${b.id}-P${b.payments[0]!.id}` } })).toBe(0);
    expect(await db.udharEntry.count({ where: { source: 'JUST_BILL', sourceId: `${b.id}-A` } })).toBe(1);
    expect(await partyMoney(s.party.id)).toBe(0); // advance −4000 consumed
  });

  it('delete returns the party + ledger to where they started', async () => {
    const s = await setup();
    await giveAdvance(s, 4000);
    const b = await jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 4000 }, { mode: 'CASH', amount: 1000 }]));
    expect(await partyMoney(s.party.id)).toBe(5000); // 5000 balance kept on the bill
    await jb.deleteJustBill(s.ctx, b.id);
    expect(await partyMoney(s.party.id)).toBe(-4000);
    expect(await jbMoneyIn()).toBe(0);
    // the credit is usable again
    const again = await jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 4000 }]));
    expect(Number(again.paid)).toBe(4000);
  });

  it('DAY_CLOSED → 403 even though no shop asset moves', async () => {
    const s = await setup();
    await giveAdvance(s, 10000);
    await closeDay(s.ctx);
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 10000 }]))).rejects.toMatchObject({ status: 403, code: 'DAY_CLOSED' });
    expect(await db.justBill.count()).toBe(0);
    expect(await partyMoney(s.party.id)).toBe(-10000);
  });

  it('over-balance → 409 OVER_BALANCE (more than the credit, or no credit at all); nothing is written', async () => {
    const s = await setup();
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 1 }]))).rejects.toMatchObject({ status: 409, details: { code: 'OVER_BALANCE' } });
    await giveAdvance(s, 4000);
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 4000.01 }]))).rejects.toMatchObject({ status: 409 });
    // two rows that together exceed the credit
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'UDHAR_ADVANCE', amount: 3000 }, { mode: 'UDHAR_ADVANCE', amount: 1001 }]))).rejects.toMatchObject({ status: 409 });
    expect(await db.justBill.count()).toBe(0);
    expect(await partyMoney(s.party.id)).toBe(-4000);
  });

  it('no party (walk-in) → 400', async () => {
    const s = await setup();
    await giveAdvance(s, 10000);
    await expect(jb.createJustBill(s.ctx, bill({ customerName: 'Walk In' }, [{ mode: 'UDHAR_ADVANCE', amount: 10000 }]))).rejects.toMatchObject({ status: 400 });
    expect(await db.justBill.count()).toBe(0);
  });
});
