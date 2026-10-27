import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviInterest } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import * as girvi from './service';
import { girviDocPath, saveGirviDoc } from '../uploads';
import { readFile, rm } from 'node:fs/promises';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});
const parse = (o: Record<string, unknown>) => girviBody.parse(o);
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const iso = (d: Date) => businessDate(d).toISOString().slice(0, 10);
const item = (net: number, purity: number, rate: number) => ({ category: 'Gold', name: 'Chain', gross: net + 2, net, purity, rate });

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, party, bank, ctx: ctxFor(business.id, root.id) };
}
const loan = (over: Record<string, unknown>) => parse({ partyId: 0, items: [item(10, 91.67, 6000)], principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3, cash: 50000, online: 0, ...over });

describe('girvi (TASK-61)', () => {
  it('create → GRANT + MONEY OUT; interestDue matches the shared girviInterest', async () => {
    const s = await setup();
    const g = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: daysAgo(30) }));
    expect(g.girviNo).toBe(1);
    expect(Number(g.principal)).toBe(50000);
    const led = await db.ledgerEntry.findMany({ where: { source: 'GIRVI', asset: 'MONEY' } });
    expect(led).toHaveLength(1);
    expect(led[0]!.direction).toBe('OUT');
    expect(Number(led[0]!.amount)).toBe(50000);
    const expected = girviInterest({ principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', from: iso(daysAgo(30)), to: iso(new Date()) }).interest;
    expect(g.interestDue).toBe(expected);
    expect(Number(g.payable)).toBeCloseTo(50000 + Number(expected), 2);
  });

  it('full interest pay moves interestFrom to the pay date; a partial pay does not; over-pay → 400', async () => {
    const s = await setup();
    const due = () => girviInterest({ principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', from: iso(daysAgo(30)), to: iso(new Date()) }).interest;

    const partial = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: daysAgo(30) }));
    await expect(girvi.payInterest(s.ctx, partial.id, { interest: Number(due()) + 500, discount: 0, cash: Number(due()) + 500, online: 0 })).rejects.toMatchObject({ status: 400 });
    await girvi.payInterest(s.ctx, partial.id, { interest: Math.round(Number(due()) / 2), discount: 0, cash: Math.round(Number(due()) / 2), online: 0 });
    expect((await girvi.getGirvi(s.ctx, partial.id, new Date())).interestFrom).toBe(iso(daysAgo(30))); // unchanged

    const full = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: daysAgo(30) }));
    await girvi.payInterest(s.ctx, full.id, { interest: Number(due()), discount: 0, cash: Number(due()), online: 0 });
    expect((await girvi.getGirvi(s.ctx, full.id, new Date())).interestFrom).toBe(iso(new Date())); // moved to today
  });

  it('top-up requires interest paid up to date (409), then adds to the principal', async () => {
    const s = await setup();
    const g = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: daysAgo(30) }));
    await expect(girvi.topupGirvi(s.ctx, g.id, { principal: 10000, cash: 10000, online: 0 })).rejects.toMatchObject({ status: 409 });
    const due = girviInterest({ principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', from: iso(daysAgo(30)), to: iso(new Date()) }).interest;
    await girvi.payInterest(s.ctx, g.id, { interest: Number(due), discount: 0, cash: Number(due), online: 0 });
    await girvi.topupGirvi(s.ctx, g.id, { principal: 10000, cash: 10000, online: 0 });
    expect(Number((await girvi.getGirvi(s.ctx, g.id, new Date())).principal)).toBe(60000);
  });

  it('partial release keeps ACTIVE; double release → 409; last release needs the full principal and CLOSES', async () => {
    const s = await setup();
    const g = await girvi.createGirvi(s.ctx, parse({ partyId: s.party.id, items: [item(10, 91.67, 6000), item(8, 91.67, 6000)], principal: 40000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3, cash: 40000, online: 0 }));
    const [a, b] = g.items;
    await girvi.releaseGirvi(s.ctx, g.id, { itemIds: [a!.id], principalPaid: 10000, interestPaid: 0, discount: 0, cash: 10000, online: 0 });
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).status).toBe('ACTIVE');
    expect((await db.girviItem.findUniqueOrThrow({ where: { id: a!.id } })).status).toBe('RELEASED');
    await expect(girvi.releaseGirvi(s.ctx, g.id, { itemIds: [a!.id], principalPaid: 0, interestPaid: 0, discount: 0, cash: 0, online: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(girvi.releaseGirvi(s.ctx, g.id, { itemIds: [b!.id], principalPaid: 5000, interestPaid: 0, discount: 0, cash: 5000, online: 0 })).rejects.toMatchObject({ status: 400 }); // not full
    await girvi.releaseGirvi(s.ctx, g.id, { itemIds: [b!.id], principalPaid: 30000, interestPaid: 0, discount: 0, cash: 30000, online: 0 });
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).status).toBe('CLOSED');
  });

  it('delete only a GRANT-only batch (409 once there is another txn); cross-tenant party/bank → 404', async () => {
    const s = await setup();
    const g = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id }));
    await girvi.deleteGirvi(s.ctx, g.id); // GRANT only → ok
    expect(await db.girviBatch.findUnique({ where: { id: g.id } })).toBeNull();

    const g2 = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: daysAgo(10) }));
    const due = girviInterest({ principal: 50000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', from: iso(daysAgo(10)), to: iso(new Date()) }).interest;
    await girvi.payInterest(s.ctx, g2.id, { interest: Number(due), discount: 0, cash: Number(due), online: 0 });
    await expect(girvi.deleteGirvi(s.ctx, g2.id)).rejects.toMatchObject({ status: 409 });

    const other = await createBusiness({ name: 'B' });
    const oParty = await db.party.create({ data: { businessId: other.business.id, type: 'CUSTOMER', name: 'X', mobile: '9000000002', countryCode: '+91' } });
    await expect(girvi.createGirvi(s.ctx, loan({ partyId: oParty.id }))).rejects.toMatchObject({ status: 404 });
    const oBank = await db.bankAccount.create({ data: { businessId: other.business.id, branchId: 0, bankName: 'Y', accountNo: '9', ifsc: 'HDFC0009999', applyTo: 'ALL' } });
    await expect(girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, cash: 0, online: 50000, bankAccountId: oBank.id }))).rejects.toMatchObject({ status: 404 });
  });
  it('tenureDays → returnDate = issueDate + days, tenureMonths = ceil(days / 30); without it, months as before', async () => {
    const s = await setup();
    const issue = new Date('2026-01-10T00:00:00Z');
    const d = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: issue, tenureMonths: 1, tenureDays: 45 }));
    expect(d.issueDate).toBe('2026-01-10');
    expect(d.returnDate).toBe('2026-02-24');
    expect(d.tenureMonths).toBe(2);
    const m = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id, issueDate: issue, tenureMonths: 3 }));
    expect(m.returnDate).toBe('2026-04-10');
    expect(m.tenureMonths).toBe(3);
  });

  it('list marks only a GRANT-only loan deletable', async () => {
    const s = await setup();
    const a = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id }));
    const b = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id }));
    await girvi.topupGirvi(s.ctx, b.id, { principal: 1000, cash: 1000, online: 0 }); // issued today → no interest due yet
    const list = await girvi.listGirvi(s.ctx, { page: 1, pageSize: 20 });
    expect(list.items.find((r) => r.id === a.id)!.deletable).toBe(true);
    expect(list.items.find((r) => r.id === b.id)!.deletable).toBe(false);
  });

  it('customer document: PDF/image saved on the batch (docUrl), replaced on re-upload, other types → 400, other tenant → 404', async () => {
    const s = await setup();
    const g = await girvi.createGirvi(s.ctx, loan({ partyId: s.party.id }));
    expect(g.docUrl).toBeNull();
    const pdf = Buffer.from('%PDF-1.4 test');
    const rel = await saveGirviDoc(s.ctx, g.id, pdf);
    expect(rel).toMatch(/\.pdf$/);
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).docUrl).toBe(rel);
    expect((await readFile(await girviDocPath(s.ctx, g.id))).toString('ascii', 0, 5)).toBe('%PDF-');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const rel2 = await saveGirviDoc(s.ctx, g.id, png);
    expect(rel2).toMatch(/\.png$/);
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).docUrl).toBe(rel2);
    await expect(saveGirviDoc(s.ctx, g.id, Buffer.from('hello world'))).rejects.toMatchObject({ status: 400 });
    const other = await createBusiness({ name: 'B' });
    const oCtx = ctxFor(other.business.id, other.root.id);
    await expect(saveGirviDoc(oCtx, g.id, pdf)).rejects.toMatchObject({ status: 404 });
    await expect(girviDocPath(oCtx, g.id)).rejects.toMatchObject({ status: 404 });
    await rm(await girviDocPath(s.ctx, g.id), { force: true });
  });
});
