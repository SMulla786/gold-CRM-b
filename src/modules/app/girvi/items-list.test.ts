import { rm, stat } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../../test/helpers/db';
import { createBusiness } from '../../../../test/helpers/factory';
import { girviBody, girviDue, girviItemReplaceBody, girviListQuery } from '../../../shared';
import { businessDate } from '../../../lib/ledger';
import { girviItemPhotoPath, saveGirviItemPhoto } from '../uploads';
import * as girvi from './service';
import type { TenantContext } from '../../../middleware/context';

/** GIR-05: item replace / revalue (valuation, rates, interest, guards, audit), list enrichment + filters, item photos. */

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['girvi'], limits: null, permissions: {}, impersonatorId: null,
});
const daysAgo = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };
const iso = (d: Date) => businessDate(d).toISOString().slice(0, 10);

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Ramesh', mobile: '9000000001', countryCode: '+91' } });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  return { business, root, party, bank, ctx: ctxFor(business.id, root.id) };
}
type S = Awaited<ReturnType<typeof setup>>;
const item = (name: string, net: number, rate = 6000) => ({ category: 'Gold', name, gross: net + 1, net, purity: 100, rate });
/** two items of 60000 each = 120000 valuation */
const loan = (s: S, o: Record<string, unknown> = {}) => girvi.createGirvi(s.ctx, girviBody.parse({
  partyId: s.party.id, issueDate: daysAgo(30), items: [item('Chain', 10), item('Ring', 10)], principal: 80000, ratePercent: 2, ratePeriod: 'MONTHLY',
  interestType: 'SI', method: 'DAY_WISE', tenureMonths: 12, cash: 80000, online: 0, ...o,
}));
const replace = (s: S, batchId: number, itemId: number, o: Record<string, unknown>) =>
  girvi.replaceGirviItem(s.ctx, batchId, itemId, girviItemReplaceBody.parse({ ...item('Bangle', 10), remark: 'swapped', ...o }));
const settleInterest = async (s: S, id: number) => {
  const due = (await girvi.getGirvi(s.ctx, id, new Date())).interestDue;
  await girvi.payInterest(s.ctx, id, { interest: Number(due), discount: 0, cash: Number(due), online: 0 });
};

describe('girvi item replace / revalue (GIR-05)', () => {
  it('replace recomputes the item + batch valuation, its rate drives the interest, and the swap is audited', async () => {
    const s = await setup();
    const g = await loan(s);
    const [chain] = g.items;
    const r = await replace(s, g.id, chain!.id, { name: 'Bangle', net: 12.345, purity: 91.6, rate: 6543.21, ratePercent: 3 });
    const bangle = r.items.find((i) => i.id === chain!.id)!;
    // fine 12.345 × 91.6% = 11.30802 (shown 11.308); valuation uses the exact fine, as createGirvi does: × 6543.21 = 73990.7466 → 73990.75
    expect([bangle.name, bangle.fine, bangle.valuation, bangle.ratePercent, bangle.status]).toEqual(['Bangle', '11.308', '73990.75', '3', 'PLEDGED']);
    expect(r.valuation).toBe('133990.75');
    const due = girviDue({
      principal: r.principal, ratePercent: r.ratePercent, ratePeriod: r.ratePeriod, interestType: r.interestType, method: r.method,
      items: r.items.map((i) => ({ valuation: i.valuation, ratePercent: i.ratePercent })), issueDate: r.issueDate, interestFrom: r.interestFrom, returnDate: r.returnDate, to: iso(new Date()),
    });
    expect(r.interestDue).toBe(due.interest);
    expect(Number(r.interestBreakdown!.effectiveRate)).toBeGreaterThan(2);
    const log = await db.activityLog.findFirstOrThrow({ where: { entity: 'GIRVI', entityId: String(g.id), action: 'EDITED' } });
    expect(log.summary).toBe(`Girvi #${g.girviNo} item replaced: Chain 10.000g ₹60000.00 → Bangle 12.345g ₹73990.75 (swapped)`);
  });

  it('guards: below the outstanding loan → 400 and nothing changes; released / other-batch item → 409; closed loan → 409; other tenant → 404', async () => {
    const s = await setup();
    const g = await loan(s);
    const [chain, ring] = g.items;
    await expect(replace(s, g.id, chain!.id, { net: 1 })).rejects.toMatchObject({ status: 400 }); // 6000 + 60000 < 80000
    const after = await girvi.getGirvi(s.ctx, g.id, new Date());
    expect([after.valuation, after.items[0]!.name, after.items[0]!.net]).toEqual(['120000.00', 'Chain', '10.000']);

    const other = await loan(s, { principal: 1000, cash: 1000 });
    await expect(replace(s, g.id, other.items[0]!.id, {})).rejects.toMatchObject({ status: 409 });
    await settleInterest(s, g.id);
    await girvi.releaseGirvi(s.ctx, g.id, { itemIds: [ring!.id], principalPaid: 20000, interestPaid: 0, discount: 0, cash: 20000, online: 0 });
    await expect(replace(s, g.id, ring!.id, {})).rejects.toMatchObject({ status: 409 });
    await girvi.releaseGirvi(s.ctx, g.id, { itemIds: [chain!.id], principalPaid: 60000, interestPaid: 0, discount: 0, cash: 60000, online: 0 });
    await expect(replace(s, g.id, chain!.id, {})).rejects.toMatchObject({ status: 409 }); // CLOSED

    const b = await setup('B');
    await expect(girvi.replaceGirviItem(b.ctx, other.id, other.items[0]!.id, girviItemReplaceBody.parse({ ...item('X', 1), remark: 'xx' }))).rejects.toMatchObject({ status: 404 });
  });

  // regression: the "loan ≤ valuation" check used to sum every item of the batch, RELEASED ones included, so after a
  // partial release a pledged item could be revalued below the loan it secures.
  it('after a partial release, revaluing the remaining item below the outstanding loan → 400', async () => {
    const s = await setup();
    const g = await loan(s, { principal: 50000, cash: 50000 });
    const [chain, ring] = g.items;
    await settleInterest(s, g.id);
    await girvi.releaseGirvi(s.ctx, g.id, { itemIds: [ring!.id], principalPaid: 0, interestPaid: 0, discount: 0, cash: 0, online: 0 });
    // 50000 still lent against the chain alone; revalue it to 6000 → today accepted (60000 released + 6000 ≥ 50000)
    await expect(replace(s, g.id, chain!.id, { net: 1 })).rejects.toMatchObject({ status: 400 });
  });
});

describe('girvi list enrichment + filters (GIR-05)', () => {
  it('each row carries item names, pledged count, principal given/returned, interest paid, payout split and deletable', async () => {
    const s = await setup();
    const g = await loan(s, { cash: 50000, online: 30000, bankAccountId: s.bank.id });
    const fresh = await loan(s, { principal: 1000, cash: 1000 });
    await settleInterest(s, g.id);
    const paid = (await girvi.getGirvi(s.ctx, g.id, new Date())).txns.find((t) => t.type === 'INTEREST')!.interest;
    await girvi.topupGirvi(s.ctx, g.id, { principal: 5000, cash: 5000, online: 0 });
    await girvi.releaseGirvi(s.ctx, g.id, { itemIds: [g.items[1]!.id], principalPaid: 25000, interestPaid: 0, discount: 0, cash: 25000, online: 0 });

    const list = await girvi.listGirvi(s.ctx, girviListQuery.parse({}));
    expect(list.items.map((r) => r.id)).toEqual([fresh.id, g.id]);
    expect(list.items[1]).toMatchObject({
      itemNames: ['Chain', 'Ring'], itemCount: 2, pledgedCount: 1, principal: '60000.00', principalGiven: '85000.00', principalReturned: '25000.00',
      interestPaid: paid, payoutCash: '50000.00', payoutOnline: '30000.00', deletable: false, status: 'ACTIVE', interestType: 'SI', ratePercent: '2',
    });
    expect(Number(paid)).toBeGreaterThan(0);
    expect(list.items[0]).toMatchObject({ deletable: true, principalGiven: '1000.00', principalReturned: '0.00', interestPaid: '0.00' });
  });

  it('filters: girvi no or mobile in q, party type, status and issue-date range; other tenants never listed', async () => {
    const s = await setup();
    const supplier = await db.party.create({ data: { businessId: s.business.id, type: 'SUPPLIER', name: 'Dealer', mobile: '9000000002', countryCode: '+91' } });
    const a = await loan(s, { issueDate: daysAgo(40) });
    const b = await loan(s, { partyId: supplier.id, issueDate: daysAgo(5) });
    const c = await loan(s, { principal: 1000, cash: 1000, issueDate: daysAgo(5) });
    await settleInterest(s, c.id);
    await girvi.releaseGirvi(s.ctx, c.id, { itemIds: c.items.map((i) => i.id), principalPaid: 1000, interestPaid: 0, discount: 0, cash: 1000, online: 0 });
    const other = await setup('B');
    await loan(other);

    const ids = async (q: Record<string, unknown>) => (await girvi.listGirvi(s.ctx, girviListQuery.parse(q))).items.map((r) => r.id);
    expect(await ids({})).toEqual([c.id, b.id, a.id]);
    expect(await ids({ q: String(b.girviNo) })).toEqual([b.id]);
    expect(await ids({ q: '9000000001' })).toEqual([c.id, a.id]);
    expect(await ids({ partyType: 'SUPPLIER' })).toEqual([b.id]);
    expect(await ids({ status: 'CLOSED' })).toEqual([c.id]);
    expect(await ids({ from: iso(daysAgo(10)) })).toEqual([c.id, b.id]);
    expect(await ids({ to: iso(daysAgo(10)) })).toEqual([a.id]);
  });
});

describe('girvi item photo (GIR-05)', () => {
  it('saved on the item and shown in the DTO, replaced on re-upload, non-images → 400, other tenant → 404', async () => {
    const s = await setup();
    const g = await loan(s);
    const itemId = g.items[0]!.id;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const rel = await saveGirviItemPhoto(s.ctx, itemId, png);
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).items[0]!.photoUrl).toBe(rel);
    const first = await girviItemPhotoPath(s.ctx, itemId);
    const rel2 = await saveGirviItemPhoto(s.ctx, itemId, jpg);
    expect(rel2).not.toBe(rel);
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).items[0]!.photoUrl).toBe(rel2);
    expect(await girviItemPhotoPath(s.ctx, itemId)).not.toBe(first);
    await expect(saveGirviItemPhoto(s.ctx, itemId, Buffer.from('%PDF-1.4 not a photo'))).rejects.toMatchObject({ status: 400 });
    const b = await setup('B');
    await expect(saveGirviItemPhoto(b.ctx, itemId, png)).rejects.toMatchObject({ status: 404 });
    await expect(girviItemPhotoPath(b.ctx, itemId)).rejects.toMatchObject({ status: 404 });
    await rm(await girviItemPhotoPath(s.ctx, itemId), { force: true });
  });

  it('C4: replacing the item clears its photo; the old path is kept in the activity meta and the file is not deleted; a new photo can follow', async () => {
    const s = await setup();
    const g = await loan(s);
    const itemId = g.items[0]!.id;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const rel = await saveGirviItemPhoto(s.ctx, itemId, png);
    const oldFile = await girviItemPhotoPath(s.ctx, itemId);

    const r = await replace(s, g.id, itemId, {});
    expect(r.items.find((i) => i.id === itemId)!.photoUrl).toBeNull();
    expect(r.items.find((i) => i.id !== itemId)!.photoUrl).toBeNull(); // untouched sibling (never had one)
    const log = await db.activityLog.findFirstOrThrow({ where: { entity: 'GIRVI', entityId: String(g.id), action: 'EDITED' } });
    expect(log.meta).toEqual({ itemId, oldPhotoUrl: rel });
    expect((await stat(oldFile)).isFile()).toBe(true);
    await expect(girviItemPhotoPath(s.ctx, itemId)).rejects.toMatchObject({ status: 404 });

    const rel2 = await saveGirviItemPhoto(s.ctx, itemId, png);
    expect((await girvi.getGirvi(s.ctx, g.id, new Date())).items.find((i) => i.id === itemId)!.photoUrl).toBe(rel2);
    await rm(oldFile, { force: true });
    await rm(await girviItemPhotoPath(s.ctx, itemId), { force: true });
  });

  it('C4: replacing an item that never had a photo logs oldPhotoUrl null', async () => {
    const s = await setup();
    const g = await loan(s);
    await replace(s, g.id, g.items[0]!.id, {});
    const log = await db.activityLog.findFirstOrThrow({ where: { entity: 'GIRVI', entityId: String(g.id), action: 'EDITED' } });
    expect(log.meta).toEqual({ itemId: g.items[0]!.id, oldPhotoUrl: null });
  });
});
