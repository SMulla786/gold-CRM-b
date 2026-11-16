import { afterAll, beforeEach, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { billBody, udharBody } from '../../shared';
import * as billing from './billing/service';
import * as udharSvc from './udhar';
import type { TenantContext } from '../../middleware/context';

/** G7 closure (A3) on D-e: cash received on a sell bill through an Udhar settlement follows the PAN rule add-payment applies —
 *  the bill's cash so far plus this cash reaching ₹2,00,000 needs the party's PAN (400 PAN_REQUIRED, nothing booked). */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

it('Udhar settlement: cash taking a sell bill to ₹2,00,000 needs the PAN (400, nothing booked); online does not; with the PAN it goes', async () => {
  const { business, root } = await createBusiness({ name: 'A' });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'udhari'], limits: null, permissions: {}, impersonatorId: null,
  };
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  // ₹3,00,000 ROUGH sell, ₹1,50,000 cash at create (under the limit, no PAN needed)
  const bill = await billing.createBill(ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: party.id, items: [{ description: 'Chain', stockClass: 'GOLD', gross: 50, rate: 60000 }], payments: [{ mode: 'CASH', amount: 150000 }] }));
  expect(Number(bill.final)).toBe(300000);
  const state = async () => [await db.udharTxn.count(), await db.billPayment.count({ where: { billId: bill.id } }), String((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).paid), await db.ledgerEntry.count({ where: { source: 'UDHAR' } }), await db.udharEntry.count({ where: { source: 'UDHAR' } })];
  const settle = (o: Record<string, unknown>) => udharSvc.createUdharTxn(ctx, udharBody.parse({ partyId: party.id, settleBillId: bill.id, ...o }));

  const before = await state();
  await expect(settle({ cashIn: 60000 })).rejects.toMatchObject({ status: 400, details: { code: 'PAN_REQUIRED' } });
  expect(await state()).toEqual(before);

  await settle({ onlineIn: 60000, inBankId: bank.id }); // online is not cash
  await db.party.update({ where: { id: party.id }, data: { pan: 'ABCDE1234F' } });
  await settle({ cashIn: 60000 });
  expect(String((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).paid)).toBe('270000');
});
