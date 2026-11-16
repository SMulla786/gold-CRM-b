import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody, udharBody } from '../../../shared';
import { createUdharTxn, deleteUdharTxn } from '../udhar';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** G7 D-a: a bill settled from Udhar (BillPayment with udharTxnId, money booked under UDHAR) must not be edited —
 *  the edit re-sent that payment as plain CASH and booked the cash and the party credit a second time. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'udhari', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** ROUGH sell bill, one direct line: final = ₹60,000. */
const sell = (partyId: number, payments: unknown[]) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments });

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bill = await billing.createBill(ctx, sell(party.id, [{ mode: 'CASH', amount: 10000 }]));
  const settle = await createUdharTxn(ctx, udharBody.parse({ partyId: party.id, cashIn: 20000, settleBillId: bill.id }));
  return { ctx, party, bill, settle };
}
/** [money in hand (all sources), party owes, bill paid] */
const books = async (partyId: number, billId: number) => {
  const money = (await db.ledgerEntry.findMany({ where: { asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
  const owes = (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);
  const paid = Number((await db.bill.findUniqueOrThrow({ where: { id: billId } })).paid);
  return [money, owes, paid];
};

describe('editing a bill that was settled from Udhar', () => {
  it('→ 409 (delete the udhar settlement first); cash, party balance and bill are unchanged', async () => {
    const s = await setup();
    expect(await books(s.party.id, s.bill.id)).toEqual([30000, 30000, 30000]);
    // what the bill screen sends back: every payment it shows, the udhar one as plain cash
    await expect(billing.editBill(s.ctx, s.bill.id, sell(s.party.id, [{ mode: 'CASH', amount: 10000 }, { mode: 'CASH', amount: 20000 }]))).rejects.toMatchObject({ status: 409 });
    expect(await books(s.party.id, s.bill.id)).toEqual([30000, 30000, 30000]);
  });

  it('after the udhar settlement is deleted the edit goes through and books the money once', async () => {
    const s = await setup();
    await deleteUdharTxn(s.ctx, s.settle.id);
    expect(await books(s.party.id, s.bill.id)).toEqual([10000, 50000, 10000]);
    await billing.editBill(s.ctx, s.bill.id, sell(s.party.id, [{ mode: 'CASH', amount: 30000 }]));
    expect(await books(s.party.id, s.bill.id)).toEqual([30000, 30000, 30000]);
  });
});
