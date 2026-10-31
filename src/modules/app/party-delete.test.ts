import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import { deletePartyQuery } from '../../shared';
import type { TenantContext } from '../../middleware/context';
import { deleteParty, PARTY_REFS } from './service';

// DELETE /app/parties/:id (owner rule, G6): dues or a pending bill → 409; any history → archived (isActive=false, rows
// untouched); no history → 409 CONFIRM_REQUIRED, hard delete only with ?confirm=true.
const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['udhari', 'billing'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup(name = 'A') {
  const { business, root } = await createBusiness({ name });
  const ctx = ctxFor(business.id, root.id);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  let seq = 0;
  const bill = (final: number, paid: number, over: Record<string, unknown> = {}) => {
    seq++;
    return db.bill.create({ data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'ROUGH', billNo: `B${seq}`, seq, partyId: party.id, billDate: new Date(), sub: final, taxable: final, total: final, final, paid, ...over } });
  };
  const udhar = (amount: number, gold = 0, silver = 0) =>
    db.udharEntry.create({ data: { businessId: business.id, branchId: root.id, partyId: party.id, txnDate: new Date(), amount, gold, silver, source: 'SELL_BILL', sourceId: 'x' } });
  return { ctx, business, root, party, bill, udhar };
}
const rowsOf = async (partyId: number) => ({
  bills: await db.bill.findMany({ where: { partyId }, select: { id: true, status: true, final: true, paid: true }, orderBy: { id: 'asc' } }),
  udhar: await db.udharEntry.findMany({ where: { partyId }, select: { id: true, amount: true }, orderBy: { id: 'asc' } }),
  ledger: await db.ledgerEntry.findMany({ where: { partyId }, select: { id: true, amount: true }, orderBy: { id: 'asc' } }),
});
const partyRow = (id: number) => db.party.findUnique({ where: { id } });

describe('deleteParty', () => {
  it('outstanding dues in money, gold or silver → 409 PARTY_HAS_DUES; party stays active', async () => {
    for (const [amount, gold, silver] of [[500, 0, 0], [0, 1.5, 0], [0, 0, -20]]) {
      await truncateAll();
      const s = await setup();
      await s.udhar(amount!, gold, silver);
      await expect(deleteParty(s.ctx, s.party.id, true)).rejects.toMatchObject({ status: 409, code: 'PARTY_HAS_DUES' });
      expect((await partyRow(s.party.id))?.isActive).toBe(true);
    }
  });

  it('a pending bill (ACTIVE, final ≠ paid) → 409 PARTY_HAS_PENDING_BILLS even with udhar settled; a deleted bill does not block', async () => {
    const s = await setup();
    await s.bill(1000, 400); // udhar for it netted to zero elsewhere: the bill alone must block
    await expect(deleteParty(s.ctx, s.party.id, true)).rejects.toMatchObject({ status: 409, code: 'PARTY_HAS_PENDING_BILLS' });
    expect((await partyRow(s.party.id))?.isActive).toBe(true);

    await truncateAll();
    const t = await setup();
    await t.bill(1000, 0, { status: 'DELETED' });
    expect(await deleteParty(t.ctx, t.party.id)).toEqual({ result: 'ARCHIVED' }); // history, but nothing pending
  });

  it('settled history → ARCHIVED (also with confirm); bills, udhar and ledger rows untouched', async () => {
    const s = await setup();
    const b = await s.bill(1000, 1000);
    await s.udhar(1000);
    await s.udhar(-1000);
    await db.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, partyId: s.party.id, txnDate: new Date(), asset: 'MONEY', direction: 'IN', amount: 1000, source: 'SELL_BILL', sourceId: String(b.id) } });
    const before = await rowsOf(s.party.id);
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
    expect((await partyRow(s.party.id))?.isActive).toBe(false);
    expect(await rowsOf(s.party.id)).toEqual(before);
  });

  it('a family head (has members) is archived, never hard-deleted', async () => {
    const s = await setup();
    await db.party.create({ data: { businessId: s.business.id, type: 'CUSTOMER', name: 'Son', mobile: '9000000009', countryCode: '+91', parentId: s.party.id } });
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
  });

  it('unused party: without confirm → 409 CONFIRM_REQUIRED and nothing changes; with confirm → gone', async () => {
    const s = await setup();
    await expect(deleteParty(s.ctx, s.party.id)).rejects.toMatchObject({ status: 409, code: 'CONFIRM_REQUIRED' });
    expect((await partyRow(s.party.id))?.isActive).toBe(true);
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'DELETED' });
    expect(await partyRow(s.party.id)).toBeNull();
    await expect(deleteParty(s.ctx, s.party.id, true)).rejects.toMatchObject({ status: 404 });
  });

  it("tenant isolation: another business's party → 404 (even with confirm) and it is unchanged", async () => {
    const a = await setup('A');
    const b = await setup('B');
    await expect(deleteParty(a.ctx, b.party.id, true)).rejects.toMatchObject({ status: 404 });
    expect(await partyRow(b.party.id)).toMatchObject({ id: b.party.id, isActive: true });
  });

  it('deleting an archived party again: still ARCHIVED, never hard-deleted, rows unchanged', async () => {
    const s = await setup();
    await s.bill(500, 500);
    const before = await rowsOf(s.party.id);
    expect(await deleteParty(s.ctx, s.party.id)).toEqual({ result: 'ARCHIVED' });
    expect(await deleteParty(s.ctx, s.party.id, true)).toEqual({ result: 'ARCHIVED' });
    expect([(await partyRow(s.party.id))?.isActive, await rowsOf(s.party.id)]).toEqual([false, before]);
  });

  it('PARTY_REFS lists every party-id column in the schema (a new one must be added, or hard delete would orphan it)', () => {
    const inSchema = Prisma.dmmf.datamodel.models.flatMap((m) =>
      m.fields.filter((f) => /(^p|P)artyId$|^karigarId$/.test(f.name) || (m.name === 'Party' && f.name === 'parentId')).map((f) => `${m.name}.${f.name}`),
    );
    expect(PARTY_REFS.map(([t, c]) => `${t}.${c}`).sort()).toEqual(inSchema.sort());
  });

  it('query contract: confirm is true only for "true"', () => {
    expect([{}, { confirm: 'false' }, { confirm: 'true' }].map((q) => deletePartyQuery.parse(q).confirm)).toEqual([false, false, true]);
    expect(() => deletePartyQuery.parse({ confirm: 'yes' })).toThrow();
  });
});
