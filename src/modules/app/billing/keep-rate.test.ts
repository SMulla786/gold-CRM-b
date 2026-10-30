import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { billBody } from '../../../shared';
import { putSetting } from '../service';
import * as billing from './service';
import type { TenantContext } from '../../../middleware/context';

/** BILL-15 R2 (keep-rate unit frozen on the bill) + R6 (stored rate kept; a change must be confirmed and is logged with old/new, user, time). */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, ctx, party };
}

/** ROUGH sell, gold line ₹60,000 final; balance kept as SILVER at ₹80,000 per the shop silver unit (default KG_1 = 1000 g). */
const sell = (partyId: number, over: Record<string, unknown> = {}) =>
  billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId, items: [{ description: 'Ring', stockClass: 'GOLD', gross: 10, rate: 60000 }], payments: [{ mode: 'CASH', amount: 10000 }], keepBalanceAs: 'SILVER', keepRate: 80000, ...over });
const silverDue = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.silver), 0);
const silverPerGram = (ctx: TenantContext) => putSetting(ctx, 'rates.units', undefined, { gold: 'GRAM_10', silver: 'GRAM_1' });
const rateLogs = (businessId: number) => db.activityLog.findMany({ where: { businessId, summary: { startsWith: 'Keep rate changed' } } });

describe('BILL-15 R2: the keep-rate unit is frozen on the bill', () => {
  it('saved with the shop unit; a later unit switch does not reinterpret the bill on edit; new bills use the new unit', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    expect(bill.keepRateUnitGrams).toBe('1000');
    expect(await silverDue(s.party.id)).toBe(625); // ₹50,000 × 1000 g / ₹80,000

    await silverPerGram(s.ctx); // shop now quotes silver per gram
    const edited = await billing.editBill(s.ctx, bill.id, sell(s.party.id, { payments: [{ mode: 'CASH', amount: 20000 }] }));
    expect(edited.keepRateUnitGrams).toBe('1000');
    expect(await silverDue(s.party.id)).toBe(500); // ₹40,000 at the bill's own ₹80,000 / kg — not / g
    expect(await db.udharEntry.count({ where: { partyId: s.party.id, silver: { not: 0 } } })).toBeGreaterThan(0);

    const fresh = await billing.createBill(s.ctx, sell(s.party.id));
    expect(fresh.keepRateUnitGrams).toBe('1');
  });

  it('a bill saved before the unit was stored is recomputed with the current shop unit on edit, which is then recorded', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    await db.bill.update({ where: { id: bill.id }, data: { keepRateUnitGrams: null } }); // legacy row
    expect((await billing.getBill(s.ctx, bill.id)).keepRateUnitGrams).toBeNull();
    const edited = await billing.editBill(s.ctx, bill.id, sell(s.party.id));
    expect(edited.keepRateUnitGrams).toBe('1000');
    expect(await silverDue(s.party.id)).toBe(625);
  });

  it('MONEY bills store no unit; deleting a metal-kept bill reverses the metal due to zero', async () => {
    const s = await setup();
    expect((await billing.createBill(s.ctx, sell(s.party.id, { keepBalanceAs: 'MONEY', keepRate: undefined }))).keepRateUnitGrams).toBeNull();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    await billing.deleteBill(s.ctx, bill.id, true);
    expect(await silverDue(s.party.id)).toBe(0);
  });
});

describe('BILL-15 R6: changing a stored keep rate must be explicit and is audited', () => {
  it('a different rate without confirmation → 409 KEEP_RATE_CHANGE and nothing changes', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    await expect(billing.editBill(s.ctx, bill.id, sell(s.party.id, { keepRate: 90000 }))).rejects.toMatchObject({ status: 409, details: { code: 'KEEP_RATE_CHANGE' } });
    await expect(billing.editBill(s.ctx, bill.id, sell(s.party.id, { keepBalanceAs: 'MONEY', keepRate: undefined }))).rejects.toMatchObject({ status: 409, details: { code: 'KEEP_RATE_CHANGE' } });
    const after = await billing.getBill(s.ctx, bill.id);
    expect([after.keepBalanceAs, after.keepRate]).toEqual(['SILVER', '80000']);
    expect(await silverDue(s.party.id)).toBe(625);
    expect(await rateLogs(s.business.id)).toEqual([]);
  });

  it('confirmed change: saved, weight recomputed once, logged with old + new rate, unit, user and time', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    const before = new Date();
    await billing.editBill(s.ctx, bill.id, sell(s.party.id, { keepRate: 100000, keepRateChange: true }));
    expect(await silverDue(s.party.id)).toBe(500); // ₹50,000 × 1000 / ₹100,000
    const [log, ...more] = await rateLogs(s.business.id);
    expect(more).toEqual([]);
    expect(log).toMatchObject({
      userId: 1, entity: 'BILL', entityId: String(bill.id),
      meta: { change: 'KEEP_RATE', old: { keepBalanceAs: 'SILVER', keepRate: '80000', unitGrams: '1000' }, new: { keepBalanceAs: 'SILVER', keepRate: '100000', unitGrams: '1000' } },
    });
    expect(log!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('same rate → no confirmation needed, nothing logged; a MONEY bill may start keeping metal without confirmation', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    await billing.editBill(s.ctx, bill.id, sell(s.party.id, { payments: [{ mode: 'CASH', amount: 20000 }] }));
    const money = await billing.createBill(s.ctx, sell(s.party.id, { keepBalanceAs: 'MONEY', keepRate: undefined }));
    const now = await billing.editBill(s.ctx, money.id, sell(s.party.id));
    expect([now.keepBalanceAs, now.keepRateUnitGrams]).toEqual(['SILVER', '1000']);
    expect(await rateLogs(s.business.id)).toEqual([]);
  });

  it('tenant isolation: another business cannot edit the bill or change its rate', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, sell(s.party.id));
    const b = await setup('B');
    await expect(billing.editBill(b.ctx, bill.id, sell(b.party.id, { keepRate: 90000, keepRateChange: true }))).rejects.toMatchObject({ status: 404 });
    expect((await billing.getBill(s.ctx, bill.id)).keepRate).toBe('80000');
    expect(await rateLogs(b.business.id)).toEqual([]);
  });
});
