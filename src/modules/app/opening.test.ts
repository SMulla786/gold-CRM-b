import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import * as opening from './opening';
import type { TenantContext } from '../../middleware/context';

const ctxFor = (businessId: number, branchId: number): TenantContext => ({
  userId: 1, level: 'ADMIN', isOwner: true, businessId, scopeBranchId: branchId, branchIds: [branchId], activeBranchId: branchId,
  readOnly: false, modules: ['settings'], limits: null, permissions: {}, impersonatorId: null,
});

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const bank = await db.bankAccount.create({ data: { businessId: business.id, branchId: 0, bankName: 'HDFC', accountNo: '1', ifsc: 'HDFC0001234', applyTo: 'ALL' } });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  return { business, root, bank, party, ctx: ctxFor(business.id, root.id) };
}

describe('opening balances (TASK-51)', () => {
  it('posts cash/bank/metal to the ledger and party to udhar, under one shared sourceId', async () => {
    const s = await setup();
    const batch = await opening.createOpeningBalances(s.ctx, {
      remark: 'Go-live',
      entries: [
        { kind: 'CASH', amount: 50000 },
        { kind: 'BANK', bankAccountId: s.bank.id, amount: 100000 },
        { kind: 'METAL', metal: 'GOLD', metalForm: 'BULLION', fine: 500 },
        { kind: 'PARTY', partyId: s.party.id, amount: 20000, gold: 0, silver: 0 },
      ],
    });
    expect(batch.sourceId).toBeTruthy();
    expect(Number(batch.cash)).toBe(50000);
    expect(batch.bank).toHaveLength(1);
    expect(Number(batch.bank[0]!.amount)).toBe(100000);
    expect(batch.bank[0]!.bankAccount.name).toBe('HDFC');
    expect(batch.metal[0]).toMatchObject({ metal: 'GOLD', metalForm: 'BULLION' });
    expect(Number(batch.metal[0]!.fine)).toBe(500);
    expect(Number(batch.parties[0]!.amount)).toBe(20000);
    expect(batch.remark).toBe('Go-live');
    expect(batch.reversed).toBe(false);

    const led = await db.ledgerEntry.findMany({ where: { source: 'OPENING_BALANCE' } });
    expect(led.filter((r) => r.asset === 'MONEY' && r.bankAccountId == null && Number(r.amount) === 50000)).toHaveLength(1);
    expect(led.filter((r) => r.asset === 'MONEY' && r.bankAccountId === s.bank.id)).toHaveLength(1);
    expect(led.filter((r) => r.asset === 'GOLD' && Number(r.fine) === 500 && r.direction === 'IN')).toHaveLength(1);
    expect((await db.udharEntry.findMany({ where: { source: 'OPENING_BALANCE', partyId: s.party.id } }))[0]!.amount.toString()).toBe('20000');

    // all share one sourceId
    expect(new Set([...led.map((r) => r.sourceId)]).size).toBe(1);
    expect(led[0]!.sourceId).toBe(batch.sourceId);
  });

  it('GET lists batches and DELETE reverses to zero (reversed flag true after)', async () => {
    const s = await setup();
    const batch = await opening.createOpeningBalances(s.ctx, { entries: [{ kind: 'CASH', amount: 50000 }, { kind: 'PARTY', partyId: s.party.id, amount: 20000, gold: 0, silver: 0 }] });
    expect((await opening.listOpeningBalances(s.ctx)).map((b) => b.sourceId)).toEqual([batch.sourceId]);

    await opening.deleteOpeningBalances(s.ctx, batch.sourceId);
    const moneyNet = (await db.ledgerEntry.findMany({ where: { source: 'OPENING_BALANCE', asset: 'MONEY' } })).reduce((a, r) => a + (r.direction === 'IN' ? 1 : -1) * Number(r.amount), 0);
    expect(moneyNet).toBe(0);
    const udharNet = (await db.udharEntry.findMany({ where: { source: 'OPENING_BALANCE' } })).reduce((a, r) => a + Number(r.amount), 0);
    expect(udharNet).toBe(0);
    const after = await opening.listOpeningBalances(s.ctx);
    expect(after[0]!.reversed).toBe(true);
    await expect(opening.deleteOpeningBalances(s.ctx, 'no-such-source')).rejects.toMatchObject({ status: 404 });
  });

  it('cross-tenant bank / party → 404', async () => {
    const s = await setup();
    const b = await createBusiness({ name: 'B' });
    const bBank = await db.bankAccount.create({ data: { businessId: b.business.id, branchId: 0, bankName: 'X', accountNo: '9', ifsc: 'HDFC0009999', applyTo: 'ALL' } });
    const bParty = await db.party.create({ data: { businessId: b.business.id, type: 'CUSTOMER', name: 'Y', mobile: '9000000002', countryCode: '+91' } });
    await expect(opening.createOpeningBalances(s.ctx, { entries: [{ kind: 'BANK', bankAccountId: bBank.id, amount: 100 }] })).rejects.toMatchObject({ status: 404 });
    await expect(opening.createOpeningBalances(s.ctx, { entries: [{ kind: 'PARTY', partyId: bParty.id, amount: 100, gold: 0, silver: 0 }] })).rejects.toMatchObject({ status: 404 });
  });
});
