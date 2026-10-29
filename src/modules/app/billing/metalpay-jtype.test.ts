/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { addBillPaymentsBody, billBody } from '../../../shared';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** Sell Bill parity: METAL payment jewellery type is saved, returned, and limited to global + own-business types. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const { business: otherBiz } = await createBusiness({ name: 'B' });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const global = await db.jewelleryType.create({ data: { businessId: null, name: 'Chain', stockClass: 'GOLD' } });
  const own = await db.jewelleryType.create({ data: { businessId: business.id, name: 'Old Bangle', stockClass: 'GOLD' } });
  const foreign = await db.jewelleryType.create({ data: { businessId: otherBiz.id, name: 'Not mine', stockClass: 'GOLD' } });
  return { ctx, party, global, own, foreign };
}

const metal = (jewelleryTypeId?: number) => ({ mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 1, tunch: 100, rate: 60000, jewelleryTypeId });
const sell = (partyId: number, payments: unknown[]) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments });

describe('METAL payment jewellery type', () => {
  it('create / edit / add-payment save it; getBill returns { id, name }', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id, [metal(s.own.id), metal()]));
    expect(bill.payments.map((p) => p.jewelleryType)).toEqual([{ id: s.own.id, name: 'Old Bangle' }, null]);

    const edited = await billing.editBill(s.ctx, bill.id, sell(s.party.id, [metal(s.global.id)]));
    expect(edited.payments.filter((p) => p.isActive).map((p) => p.jewelleryType?.name)).toEqual(['Chain']);

    const added = await billing.addBillPayments(s.ctx, bill.id, addBillPaymentsBody.parse({ payments: [metal(s.own.id)] }));
    expect(added.payments.filter((p) => p.isActive).map((p) => p.jewelleryType?.name)).toEqual(['Chain', 'Old Bangle']);
  });

  it("another business's type → 404 and nothing is written", async () => {
    const s = await setup();
    await expect(billing.createBill(s.ctx, sell(s.party.id, [metal(s.foreign.id)]))).rejects.toMatchObject({ status: 404 });
    expect(await db.bill.count()).toBe(0);
  });
});
