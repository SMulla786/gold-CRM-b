import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../../test/helpers/factory';
import { billBody, exchangeBody, kachaProcessBody } from '../../../shared';
import * as billing from '../billing/service';
import * as inv from '../inventory';
import * as exchange from './exchange';
import * as kacha from './kacha';
import type { TenantContext } from '../../../middleware/context';

/** G5 features 6–8 (owner rules 2026-10-30): PROCESS batch reserves kacha (no ledger), nothing else may draw it; a child
 *  REFINE consumes the reservation atomically; parent revert only after its refines; self difference (record only);
 *  grouped list / detail / summary views. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['exchange', 'billing', 'inventory'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, party, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;
const buy = (s: S, weight: number, o: Record<string, unknown> = {}) =>
  exchange.createExchange(s.ctx, exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight, touch: 100 }], rate: 0, ...o }));
const proc = (s: S, o: Record<string, unknown>) => kacha.processKacha(s.ctx, kachaProcessBody.parse({ metal: 'GOLD', ...o }));
const batch = (s: S, exchangeIds: number[]) => proc(s, { type: 'PROCESS', exchangeIds });
const refine = (s: S, parentId: number, inFine: number, o: Record<string, unknown> = {}) => proc(s, { type: 'REFINE', parentId, inFine, outFine: inFine - 1, ...o });
const card = (s: S) => kacha.kachaBalanceCard(s.ctx, { metal: 'GOLD' });
const available = async (s: S) => { const c = await card(s); return Number(c.kachaFine) - Number(c.reservedFine); };

describe('6 · PROCESS batch', () => {
  it('reserves the full fine of its exchanges with no ledger row; reserved kacha cannot be melted, sold or paid away', async () => {
    const s = await setup();
    const [a, b] = [await buy(s, 10), await buy(s, 5)];
    const p = await batch(s, [b.id, a.id]);
    expect([p.type, p.inFine, p.kachaWeight, p.reservedFine, p.exchanges?.map((e) => e.id)]).toEqual(['PROCESS', '15.000', '15.000', '15.000', [a.id, b.id]]);
    expect(await db.ledgerEntry.count({ where: { source: { in: ['EXCHANGE_MELT_PROCESS', 'EXCHANGE_REFINE'] } } })).toBe(0);
    expect([(await card(s)).kachaFine, (await card(s)).reservedFine]).toEqual(['15.000', '15.000']);

    await expect(proc(s, { type: 'MELT', inFine: 1, outFine: 1 })).rejects.toMatchObject({ status: 409, details: { code: 'KACHA_SHORT' } });
    await expect(proc(s, { type: 'MELT', inFine: 1, outFine: 1, exchangeId: a.id })).rejects.toMatchObject({ status: 409, details: { code: 'LINKED_FINE_EXCEEDED' } });
    await expect(exchange.createExchange(s.ctx, exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'SELL', lines: [{ weight: 1, touch: 100 }] }))).rejects.toMatchObject({ status: 409 });
    const supplier = await db.party.create({ data: { businessId: s.business.id, type: 'SUPPLIER', name: 'Supp', mobile: '9000000003', countryCode: '+91' } });
    const [group] = await inv.createItemGroups(s.ctx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
    const name = await inv.createItemName(s.ctx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
    await expect(billing.createBill(s.ctx, billBody.parse({ kind: 'PURCHASE', billType: 'ROUGH', partyId: supplier.id, items: [{ itemNameId: name!.id, gross: 5, rate: 5000 }], payments: [{ mode: 'METAL', metal: 'GOLD', metalForm: 'KACHA', gross: 1, tunch: 100, rate: 50000 }] }))).rejects.toMatchObject({ status: 409 });

    await expect(exchange.updateExchange(s.ctx, a.id, exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', lines: [{ weight: 9, touch: 100 }] }))).rejects.toMatchObject({ status: 409 });
    await expect(exchange.deleteExchange(s.ctx, b.id)).rejects.toMatchObject({ status: 409 });
    await expect(batch(s, [a.id])).rejects.toMatchObject({ status: 409 }); // already in a batch
    expect((await exchange.getExchange(s.ctx, a.id)).processed).toBe(true);
  });

  it('only whole, unprocessed BUY exchanges of this metal and branch; anything else → 4xx and nothing is reserved', async () => {
    const s = await setup();
    const part = await buy(s, 10);
    await proc(s, { type: 'MELT', inFine: 2, outFine: 2, exchangeId: part.id });
    await expect(batch(s, [part.id])).rejects.toMatchObject({ status: 409 });
    const silver = await buy(s, 10, { metal: 'SILVER' });
    await expect(batch(s, [silver.id])).rejects.toMatchObject({ status: 409 });
    const sell = await exchange.createExchange(s.ctx, exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'SELL', lines: [{ weight: 1, touch: 100 }] }));
    await expect(batch(s, [sell.id])).rejects.toMatchObject({ status: 409 });
    const branch2 = await createBranch({ businessId: s.business.id, parentId: s.root.id, name: 'B2', isAdminNode: false });
    const other = await buy({ ...s, ctx: ctxFor(s.business.id, branch2.id) }, 5);
    await expect(batch(s, [other.id])).rejects.toMatchObject({ status: 404 });
    const b = await setup('B');
    const foreign = await buy(b, 5);
    await expect(batch(s, [foreign.id])).rejects.toMatchObject({ status: 404 });
    expect((await card(s)).reservedFine).toBe('0.000');
  });
});

describe('6 · refines of a batch, revert order, concurrency', () => {
  it('a child REFINE consumes the reservation atomically (ledger + reservation fall together); over the batch → 409', async () => {
    const s = await setup();
    const p = await batch(s, [(await buy(s, 10)).id, (await buy(s, 5)).id]);
    const r1 = await refine(s, p.id, 10, { outFine: 9, ravalFine: 0.5, selfDiff: -0.2 });
    expect([r1.parentId, r1.selfDiff, r1.difference]).toEqual([p.id, '-0.200', '0.500']);
    const c = await card(s);
    expect([c.kachaFine, c.bullionFine, c.reservedFine]).toEqual(['5.500', '9.000', '5.000']); // 15 − 10 + 0.5 raval; 5 still reserved
    expect(await available(s)).toBeCloseTo(0.5, 6); // only the raval is free
    await expect(refine(s, p.id, 6)).rejects.toMatchObject({ status: 409, details: { code: 'BATCH_FINE_EXCEEDED' } });
    await refine(s, p.id, 5);
    expect((await card(s)).reservedFine).toBe('0.000');
    await expect(refine(s, r1.id, 1)).rejects.toMatchObject({ status: 409 }); // a refine is not a batch
  });

  it('parent revert is refused while a refine is active; child first, then parent releases the reservation and the exchanges', async () => {
    const s = await setup();
    const ex = await buy(s, 10);
    const p = await batch(s, [ex.id]);
    const r = await refine(s, p.id, 4);
    await expect(kacha.revertKacha(s.ctx, p.id)).rejects.toMatchObject({ status: 409 });
    expect((await kacha.getKacha(s.ctx, p.id)).reverted).toBe(false);
    await kacha.revertKacha(s.ctx, r.id);
    expect((await card(s)).reservedFine).toBe('10.000');
    await kacha.revertKacha(s.ctx, p.id);
    expect([(await card(s)).kachaFine, (await card(s)).reservedFine]).toEqual(['10.000', '0.000']);
    await expect(refine(s, p.id, 1)).rejects.toMatchObject({ status: 409 }); // reverted batch
    await exchange.deleteExchange(s.ctx, ex.id); // free again
  });

  it('two refines racing for one batch never take more than it reserved', async () => {
    const s = await setup();
    const p = await batch(s, [(await buy(s, 15)).id]);
    const runs = await Promise.allSettled([refine(s, p.id, 8), refine(s, p.id, 8)]);
    expect(runs.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await card(s)).reservedFine).toBe('7.000');
  });
});

describe('7–8 · self difference and grouped views', () => {
  it('list by type / parent; detail with refines and exchanges; summary cards per type; other tenants never counted', async () => {
    const s = await setup();
    const p = await batch(s, [(await buy(s, 10)).id]);
    await refine(s, p.id, 4, { selfDiff: 0.3 });
    await refine(s, p.id, 3, { selfDiff: -0.1 });
    await proc(s, { type: 'MELT', inFine: 2, outFine: 1.9, exchangeId: (await buy(s, 5)).id });
    const b = await setup('B');
    await proc(b, { type: 'MELT', inFine: 1, outFine: 1, exchangeId: (await buy(b, 5)).id });

    expect((await kacha.listKacha(s.ctx, { page: 1, pageSize: 20, type: 'PROCESS' })).items.map((x) => x.id)).toEqual([p.id]);
    expect((await kacha.listKacha(s.ctx, { page: 1, pageSize: 20, parentId: p.id })).total).toBe(2);
    const detail = await kacha.getKacha(s.ctx, p.id);
    expect([detail.reservedFine, detail.children?.map((c) => c.selfDiff), detail.exchanges?.length]).toEqual(['3.000', ['0.300', '-0.100'], 1]);

    const sum = await kacha.kachaSummary(s.ctx, { metal: 'GOLD' });
    expect(sum.byType).toEqual([
      { type: 'MELT', count: 1, inFine: '2.000', outFine: '1.900', ravalFine: '0.000', difference: '0.100', selfDiff: '0.000' },
      { type: 'REFINE', count: 2, inFine: '7.000', outFine: '5.000', ravalFine: '0.000', difference: '2.000', selfDiff: '0.200' },
      { type: 'PROCESS', count: 1, inFine: '10.000', outFine: '0.000', ravalFine: '0.000', difference: '0.000', selfDiff: '0.000' },
    ]);
    expect(sum.reservedFine).toBe('3.000');
    expect(kachaProcessBody.safeParse({ metal: 'GOLD', type: 'MELT', inFine: 1, outFine: 1, selfDiff: 0.1 }).success).toBe(false); // self diff is REFINE only
    expect(kachaProcessBody.safeParse({ metal: 'GOLD', type: 'REFINE', inFine: 1, outFine: 1, selfDiff: 0.1 }).success).toBe(true);
  });
});
