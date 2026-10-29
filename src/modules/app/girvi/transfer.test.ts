import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviInterest, girviTransferBody, girviTransferReturnBody } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import * as girvi from './service';
import * as transfer from './transfer';
import type { TenantContext } from '../../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const iso = (d: Date) => businessDate(d).toISOString().slice(0, 10);
const item = (net: number) => ({ category: 'Gold', name: 'Chain', gross: net + 2, net, purity: 91.67, rate: 6000 });
const terms = { ratePercent: 1.5, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 6 } as const;

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const customer = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const lender = await db.party.create({ data: { businessId: business.id, type: 'SUPPLIER', name: 'Lender', mobile: '9000000003', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  const ctx = ctxFor(business.id, root.id);
  const g = await girvi.createGirvi(ctx, girviBody.parse({ partyId: customer.id, items: [item(10), item(8)], principal: 60000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 3, cash: 60000, online: 0 }));
  return { business, root, customer, lender, bank, ctx, g };
}
const body = (o: Record<string, unknown>) => girviTransferBody.parse({ principal: 40000, cash: 40000, online: 0, ...terms, ...o });
const ret = (o: Record<string, unknown>) => girviTransferReturnBody.parse(o);
const moneyRows = (direction: 'IN' | 'OUT') => db.ledgerEntry.findMany({ where: { source: 'GIRVI_TRANSFER', asset: 'MONEY', direction }, orderBy: { id: 'asc' } });

describe('girvi transfer (Phase 9b)', () => {
  it('create → MONEY IN split cash/bank, numbered per branch; ACTIVE interest matches the shared girviInterest', async () => {
    const s = await setup();
    const t = await transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [s.g.items[0]!.id], transferDate: daysAgo(45), cash: 25000, online: 15000, bankAccountId: s.bank.id }));
    expect(t.transferNo).toBe(1);
    expect(t.status).toBe('ACTIVE');
    expect(t.items.map((i) => i.id)).toEqual([s.g.items[0]!.id]);
    expect(t.items[0]!.girviNo).toBe(s.g.girviNo);

    const rows = await moneyRows('IN');
    expect(rows.map((r) => [Number(r.amount), r.bankAccountId])).toEqual([[25000, null], [15000, s.bank.id]]);
    expect(rows.every((r) => r.partyId === s.lender.id && r.sourceId === String(t.id))).toBe(true);

    const expected = girviInterest({ principal: 40000, ...terms, from: iso(daysAgo(45)), to: iso(new Date()) }).interest;
    expect(t.interest).toBe(expected);
    expect(Number(expected)).toBeGreaterThan(0);

    const t2 = await transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [s.g.items[1]!.id] }));
    expect(t2.transferNo).toBe(2);
  });

  it('an item already with a lender, or not pledged, cannot be transferred (409); while out, the customer cannot release it (409)', async () => {
    const s = await setup();
    const [a, b] = s.g.items;
    await transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [a!.id] }));
    await expect(transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [a!.id] }))).rejects.toMatchObject({ status: 409 });
    await expect(transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [b!.id, 999999] }))).rejects.toMatchObject({ status: 409 });
    await expect(girvi.releaseGirvi(s.ctx, s.g.id, { itemIds: [a!.id], principalPaid: 10000, interestPaid: 0, discount: 0, cash: 10000, online: 0 })).rejects.toMatchObject({ status: 409 });

    await girvi.releaseGirvi(s.ctx, s.g.id, { itemIds: [b!.id], principalPaid: 10000, interestPaid: 0, discount: 0, cash: 10000, online: 0 });
    await expect(transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [b!.id] }))).rejects.toMatchObject({ status: 409 }); // released
    expect(await moneyRows('IN')).toHaveLength(1); // failed attempts posted nothing
  });

  it('return → MONEY OUT principal + interest exactly once; wrong total / date before transfer → 400; second return → 409; item releasable again', async () => {
    const s = await setup();
    const a = s.g.items[0]!;
    const t = await transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [a.id], transferDate: daysAgo(30) }));

    await expect(transfer.returnTransfer(s.ctx, t.id, ret({ interest: 600, cash: 40000, online: 0 }))).rejects.toMatchObject({ status: 400 });
    await expect(transfer.returnTransfer(s.ctx, t.id, ret({ returnedOn: daysAgo(31), interest: 0, cash: 40000, online: 0 }))).rejects.toMatchObject({ status: 400 });
    expect(await moneyRows('OUT')).toHaveLength(0);

    const done = await transfer.returnTransfer(s.ctx, t.id, ret({ interest: 600, cash: 30600, online: 10000, bankAccountId: s.bank.id }));
    expect(done.status).toBe('RETURNED');
    expect(done.interest).toBe('600.00');
    expect(done.returnedOn).toBe(iso(new Date()));
    const out = await moneyRows('OUT');
    expect(out.map((r) => [Number(r.amount), r.bankAccountId])).toEqual([[30600, null], [10000, s.bank.id]]);

    await expect(transfer.returnTransfer(s.ctx, t.id, ret({ interest: 600, cash: 40600, online: 0 }))).rejects.toMatchObject({ status: 409 });
    expect(await moneyRows('OUT')).toHaveLength(2);

    await girvi.releaseGirvi(s.ctx, s.g.id, { itemIds: [a.id], principalPaid: 10000, interestPaid: 0, discount: 0, cash: 10000, online: 0 });
    expect((await db.girviItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED');
  });

  it('list filters by status; another tenant gets 404 on lender, bank, items and the transfer itself', async () => {
    const s = await setup();
    const t1 = await transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [s.g.items[0]!.id] }));
    await transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [s.g.items[1]!.id] }));
    await transfer.returnTransfer(s.ctx, t1.id, ret({ interest: 0, cash: 40000, online: 0 }));
    const page = { page: 1, pageSize: 20 };
    expect((await transfer.listTransfers(s.ctx, { ...page, status: 'ACTIVE' })).items.map((r) => r.transferNo)).toEqual([2]);
    expect((await transfer.listTransfers(s.ctx, { ...page, status: 'RETURNED' })).items.map((r) => r.id)).toEqual([t1.id]);

    const other = await createBusiness({ name: 'B' });
    const oCtx = ctxFor(other.business.id, other.root.id);
    const oLender = await db.party.create({ data: { businessId: other.business.id, type: 'SUPPLIER', name: 'X', mobile: '9000000004', countryCode: '+91' } });
    const oBank = await db.bankAccount.create({ data: { businessId: other.business.id, branchId: 0, bankName: 'Y', accountNo: '9', ifsc: 'HDFC0009999', applyTo: 'ALL' } });
    await expect(transfer.createTransfer(s.ctx, body({ lenderPartyId: oLender.id, itemIds: [s.g.items[1]!.id] }))).rejects.toMatchObject({ status: 404 });
    await expect(transfer.createTransfer(s.ctx, body({ lenderPartyId: s.lender.id, itemIds: [s.g.items[1]!.id], cash: 0, online: 40000, bankAccountId: oBank.id }))).rejects.toMatchObject({ status: 404 });
    await expect(transfer.createTransfer(oCtx, body({ lenderPartyId: oLender.id, itemIds: [s.g.items[1]!.id] }))).rejects.toMatchObject({ status: 409 }); // foreign items
    await expect(transfer.getTransfer(oCtx, t1.id)).rejects.toMatchObject({ status: 404 });
    await expect(transfer.returnTransfer(oCtx, t1.id, ret({ interest: 0, cash: 40000, online: 0 }))).rejects.toMatchObject({ status: 404 });
    expect((await transfer.listTransfers(oCtx, page)).total).toBe(0);
  });
});
