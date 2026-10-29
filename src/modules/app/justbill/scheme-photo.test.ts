/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { justBillBody } from '../../../shared';
import { closeDay } from '../daybook/service';
import * as schemes from '../schemes/service';
import { justBillItemPhotoPath, saveJustBillItemPhoto } from '../uploads';
import * as jb from './service';
import type { TenantContext } from '../../../middleware/context';

/** JB-03: Just Bill SCHEME pay mode (redeem, reopen on delete) + line photo (tenant-scoped via the item's just bill). */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId,
  scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['billing', 'settings', 'daybook', 'schemes'], limits: null, permissions: {}, impersonatorId: null,
});

const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const businessIds: number[] = [];

beforeEach(truncateAll);
afterAll(async () => {
  for (const id of businessIds) await rm(path.join(UPLOAD_ROOT, String(id)), { recursive: true, force: true }).catch(() => {});
  await db.$disconnect();
});

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  businessIds.push(business.id);
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const other = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Other', mobile: '9000000002', countryCode: '+91' } });
  return { business, root, ctx, party, other };
}

/** one PCS line: final = ₹10,000 */
const bill = (o: Record<string, unknown>, payments: unknown[]) => justBillBody.parse({ ...o, items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 10000 }], payments });
const partyMoney = async (partyId: number) => (await db.udharEntry.findMany({ where: { partyId } })).reduce((a, r) => a + Number(r.amount), 0);
const jbMoneyIn = async () => (await db.ledgerEntry.findMany({ where: { source: 'JUST_BILL', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
const status = (id: number) => db.schemeEnrollment.findUniqueOrThrow({ where: { id } });

/** matured 1-month CASH scheme, no bonus → maturity value ₹2,000 */
async function maturedEnrollment(s: Awaited<ReturnType<typeof setup>>, partyId = s.party.id, assignId = 'A1') {
  const scheme = await schemes.createScheme(s.ctx, { kind: 'SAVING', type: 'CASH', name: `S-${assignId}`, emiAmount: 2000, tenureMonths: 1, bonusType: 'NONE', bonusValue: 0, startDate: new Date() });
  return schemes.enroll(s.ctx, { schemeId: scheme.id, partyId, assignId, displayName: 'C', tokenAmount: 0, firstPayment: { amount: 2000, medium: 'CASH' } } as any);
}

describe('JB-03 Just Bill SCHEME pay mode', () => {
  it('post: redeems the enrollment into the just bill, no cash ledger row for it; party nets to zero', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    const j = await jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000 }, { mode: 'CASH', amount: 8000 }]));
    expect(j.payments.find((p) => p.mode === 'SCHEME')).toMatchObject({ schemeEnrollmentId: e.id, amount: '2000' });
    const after = await status(e.id);
    expect(after).toMatchObject({ status: 'CLOSED', redeemJustBillId: j.id, statusBeforeRedeem: 'ACTIVE' });
    expect(Number(after.redeemValue)).toBe(2000);
    expect(await jbMoneyIn()).toBe(8000);
    expect(await partyMoney(s.party.id)).toBe(0); // maturity credit −2000, used by the just bill +2000
  });

  it('delete reopens the enrollment with its pre-redeem status and nets the party + ledger to zero', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    await schemes.markWon(s.ctx, e.id);
    const j = await jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 1500 }, { mode: 'CASH', amount: 8500 }]));
    expect(await partyMoney(s.party.id)).toBe(-500); // 2000 credited, 1500 used: the rest stays as party credit
    await jb.deleteJustBill(s.ctx, j.id);
    const back = await status(e.id);
    expect(back).toMatchObject({ status: 'WON', redeemJustBillId: null, redeemValue: null, statusBeforeRedeem: null, closedAt: null });
    expect(await partyMoney(s.party.id)).toBe(0);
    expect(await jbMoneyIn()).toBe(0);
  });

  it('over the value / another party\'s enrollment → 409; same enrollment twice / no party → 400; nothing written', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000.01 }]))).rejects.toMatchObject({ status: 409 });
    const theirs = await maturedEnrollment(s, s.other.id, 'B1');
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'SCHEME', enrollmentId: theirs.id, amount: 100 }]))).rejects.toMatchObject({ status: 409 });
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 100 }, { mode: 'SCHEME', enrollmentId: e.id, amount: 100 }]))).rejects.toMatchObject({ status: 400 });
    await expect(jb.createJustBill(s.ctx, bill({ customerName: 'Walk-in' }, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 100 }]))).rejects.toMatchObject({ status: 400 });
    expect((await status(e.id)).status).toBe('ACTIVE');
    expect(await db.justBill.count()).toBe(0);
    expect(await partyMoney(s.party.id)).toBe(0);
  });

  it('DAY_CLOSED → 403 and the enrollment is not redeemed', async () => {
    const s = await setup();
    const e = await maturedEnrollment(s);
    await closeDay(s.ctx);
    await expect(jb.createJustBill(s.ctx, bill({ partyId: s.party.id }, [{ mode: 'SCHEME', enrollmentId: e.id, amount: 2000 }]))).rejects.toMatchObject({ status: 403, code: 'DAY_CLOSED' });
    expect((await status(e.id)).status).toBe('ACTIVE');
  });
});

describe('JB-03 Just Bill line photo', () => {
  it('saves a line photo, getJustBill returns its URL; another business → 404; non-image → 400', async () => {
    const s = await setup();
    const j = await jb.createJustBill(s.ctx, bill({ customerName: 'Walk-in' }, [{ mode: 'CASH', amount: 10000 }]));
    const itemId = j.items[0]!.id;
    expect(j.items[0]!.photoUrl).toBeNull();
    const rel = await saveJustBillItemPhoto(s.ctx, itemId, PNG);
    expect(rel).toMatch(new RegExp(`^${s.business.id}/justbill/.+\\.png$`));
    expect((await jb.getJustBill(s.ctx, j.id)).items[0]!.photoUrl).toBe(`/api/app/justbill/items/${itemId}/photo`);
    expect(await justBillItemPhotoPath(s.ctx, itemId)).toBe(path.join(UPLOAD_ROOT, rel));

    const b = await createBusiness({ name: 'B' });
    businessIds.push(b.business.id);
    const otherCtx = ctxFor(b.business.id, b.root.id);
    await expect(saveJustBillItemPhoto(otherCtx, itemId, PNG)).rejects.toMatchObject({ status: 404 });
    await expect(justBillItemPhotoPath(otherCtx, itemId)).rejects.toMatchObject({ status: 404 });
    await expect(saveJustBillItemPhoto(s.ctx, itemId, Buffer.from('not an image'))).rejects.toMatchObject({ status: 400 });
  });
});
