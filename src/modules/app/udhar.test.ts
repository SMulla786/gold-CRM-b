import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBusiness } from '../../../test/helpers/factory';
import type { TenantContext } from '../../middleware/context';
import { createUdharTxn, deleteUdharTxn, partyBalance } from './udhar';

const ctxFor = (businessId: number, branchIds: number[], activeBranchId: number): TenantContext => ({
  userId: 1,
  level: 'ADMIN',
  isOwner: true,
  businessId,
  scopeBranchId: branchIds[0]!,
  branchIds,
  activeBranchId,
  readOnly: false,
  modules: ['udhari'],
  limits: null,
  permissions: {},
  impersonatorId: null,
});

const makeParty = (businessId: number, name = 'Cust') => db.party.create({ data: { businessId, type: 'CUSTOMER', name, mobile: '9999999999' } });
const ledgerRows = (businessId: number, sourceId: string) => db.ledgerEntry.findMany({ where: { businessId, source: 'UDHAR', sourceId } });

describe('udhar txn posting', () => {
  beforeEach(truncateAll);
  afterAll(() => db.$disconnect());

  it('cash given + received → MONEY ledger rows and a party balance of net owed', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const p = await makeParty(business.id);
    const dto = await createUdharTxn(ctx, { partyId: p.id, cashOut: 5000, onlineOut: 0, cashIn: 2000, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0 } as never);

    const rows = await ledgerRows(business.id, String(dto.id));
    expect(rows.filter((r) => r.asset === 'MONEY' && r.direction === 'OUT')).toHaveLength(1);
    expect(rows.filter((r) => r.asset === 'MONEY' && r.direction === 'IN')).toHaveLength(1);
    expect(dto.final).toEqual({ amount: '3000.00', gold: '0.000', silver: '0.000' }); // 5000 given − 2000 received
    expect(dto.old).toEqual({ amount: '0.00', gold: '0.000', silver: '0.000' });
  });

  it('online payment needs a valid bank account (404)', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const p = await makeParty(business.id);
    await expect(createUdharTxn(ctx, { partyId: p.id, cashOut: 0, onlineOut: 1000, outBankId: 999999, cashIn: 0, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0 } as never)).rejects.toMatchObject({ status: 404 });
  });

  it('gold given/received → GOLD ledger rows and a gold balance', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const p = await makeParty(business.id);
    const dto = await createUdharTxn(ctx, { partyId: p.id, cashOut: 0, onlineOut: 0, cashIn: 0, onlineIn: 0, goldOut: 10, goldIn: 4, silverOut: 0, silverIn: 0 } as never);
    const rows = await ledgerRows(business.id, String(dto.id));
    expect(rows.filter((r) => r.asset === 'GOLD')).toHaveLength(2);
    expect(dto.final.gold).toBe('6.000'); // 10 given − 4 received
  });

  it('bhav cut moves value between money and metal with NO shop ledger rows', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const m2m = await createUdharTxn(ctx, { partyId: (await makeParty(business.id, 'M2M')).id, cashOut: 0, onlineOut: 0, cashIn: 0, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0, bhav: { direction: 'MONEY_TO_METAL', metal: 'GOLD', amount: 70000, rate: 70000, unitGrams: 10 } } as never);
    expect(await ledgerRows(business.id, String(m2m.id))).toHaveLength(0); // bhav moves no shop asset
    expect(m2m.final).toEqual({ amount: '-70000.00', gold: '10.000', silver: '0.000' }); // amount −X, metal +W (W=70000/7000)

    const me2m = await createUdharTxn(ctx, { partyId: (await makeParty(business.id, 'ME2M')).id, cashOut: 0, onlineOut: 0, cashIn: 0, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0, bhav: { direction: 'METAL_TO_MONEY', metal: 'SILVER', amount: 92000, rate: 92000, unitGrams: 1000 } } as never);
    expect(me2m.final).toEqual({ amount: '92000.00', gold: '0.000', silver: '-1000.000' }); // metal −W, amount +X (W=92000/92)
  });

  it('settle a pending SELL bill: records a BillPayment, raises bill.paid, lowers balance once', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const p = await makeParty(business.id);
    const bill = await db.bill.create({
      data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'GST', billNo: 'INV-1', seq: 1, partyId: p.id, billDate: new Date('2026-01-01'), sub: 10000, taxable: 10000, total: 10000, final: 10000 },
    });
    const dto = await createUdharTxn(ctx, { partyId: p.id, cashOut: 0, onlineOut: 0, cashIn: 4000, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0, settleBillId: bill.id } as never);

    const after = await db.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.paid.toString()).toBe('4000');
    const pays = await db.billPayment.findMany({ where: { billId: bill.id } });
    expect(pays).toHaveLength(1);
    expect(pays[0]!.udharTxnId).toBe(dto.id);
    expect(dto.final.amount).toBe('-4000.00'); // received 4000 → party now in advance, counted once
  });

  it('delete reverses ledger + party balance and deactivates the settled payment', async () => {
    const { business, root } = await createBusiness({ name: 'A' });
    const ctx = ctxFor(business.id, [root.id], root.id);
    const p = await makeParty(business.id);
    const bill = await db.bill.create({
      data: { businessId: business.id, branchId: root.id, kind: 'SELL', billType: 'GST', billNo: 'INV-2', seq: 2, partyId: p.id, billDate: new Date('2026-01-01'), sub: 10000, taxable: 10000, total: 10000, final: 10000 },
    });
    const dto = await createUdharTxn(ctx, { partyId: p.id, cashOut: 1000, onlineOut: 0, cashIn: 3000, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0, settleBillId: bill.id } as never);
    await deleteUdharTxn(ctx, dto.id);

    expect(await partyBalance(ctx, p.id)).toEqual({ amount: '0.00', gold: '0.000', silver: '0.000' }); // fully reversed
    expect((await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).paid.toString()).toBe('0');
    expect((await db.billPayment.findFirstOrThrow({ where: { billId: bill.id } })).isActive).toBe(false);
  });

  it('cross-tenant party is not found (404)', async () => {
    const a = await createBusiness({ name: 'A' });
    const b = await createBusiness({ name: 'B' });
    const bParty = await makeParty(b.business.id);
    const ctx = ctxFor(a.business.id, [a.root.id], a.root.id);
    await expect(createUdharTxn(ctx, { partyId: bParty.id, cashOut: 100, onlineOut: 0, cashIn: 0, onlineIn: 0, goldOut: 0, goldIn: 0, silverOut: 0, silverIn: 0 } as never)).rejects.toMatchObject({ status: 404 });
  });
});
