import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness } from '../../../test/helpers/factory';
import { billBody } from '../../shared';
import * as ledger from '../../lib/ledger';
import { businessDate } from '../../lib/ledger';
import * as inv from './inventory';
import * as billing from './billing/service';
import type { TenantContext } from '../../middleware/context';

/** G7 D-f: a LOOSE lot that is partly on a live sell bill stays put — no transfer, edit or delete (a bill delete returns the sold part to it).
 *  The check runs under the stock-row lock: a partial LOOSE sale doesn't change the status, so a status guard alone lets a racing sale through. */

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

/** A 20 g LOOSE gold lot in the root branch (a child branch to move it to). */
async function setup() {
  const { business, root } = await createBusiness({ name: 'A' });
  const child = await createBranch({ businessId: business.id, parentId: root.id, name: 'Child' });
  await db.karatMapping.create({ data: { businessId: business.id, metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 } });
  const ctx: TenantContext = {
    userId: 1, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id, child.id], activeBranchId: root.id,
    readOnly: false, modules: ['billing', 'inventory', 'settings', 'daybook'], limits: null, permissions: {}, impersonatorId: null,
  };
  const [group] = await inv.createItemGroups(ctx, { stockClass: 'GOLD', names: ['Bars'], gstRate: 3 });
  const looseName = await inv.createItemName(ctx, { groupId: group!.id, name: 'Gold Bar', method: 'LOOSE' });
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const e = await inv.createStockEntry(ctx, { stockClass: 'GOLD', method: 'LOOSE', branchId: root.id, rows: [{ itemNameId: looseName!.id, karatCode: '22K', gross: 20, pcs: 1, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0 }] });
  const lot = e.items[0]!.id;
  const move = () => inv.createStockTransfer(ctx, { fromBranchId: root.id, toBranchId: child.id, stockItemIds: [lot] });
  return { business, root, child, ctx, party, lot, move };
}
type S = Awaited<ReturnType<typeof setup>>;
const lotRow = (s: S) => db.stockItem.findUniqueOrThrow({ where: { id: s.lot } });

/** Resolves once another connection of this DB is waiting on a row lock. */
async function lockWaiter(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const [{ n } = { n: 0 }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('no connection ever blocked on the stock row');
}
/** Runs `op` while a partial sale of 5 g of the lot is mid-flight (row decremented, live SELL_BILL row written); the sale commits once `op` waits on the row. */
async function duringSale(s: S, op: () => Promise<unknown>): Promise<unknown> {
  let sold!: () => void;
  const inFlight = new Promise<void>((r) => (sold = r));
  const sale = db.$transaction(async (t) => {
    await t.stockItem.update({ where: { id: s.lot }, data: { gross: { decrement: 5 } } });
    await t.ledgerEntry.create({ data: { businessId: s.business.id, branchId: s.root.id, txnDate: businessDate(), asset: 'GOLD', direction: 'OUT', gross: 5, source: 'SELL_BILL', sourceId: '999', stockItemId: s.lot } });
    sold();
    await lockWaiter();
  });
  await inFlight;
  const res = op().catch((e: unknown) => e);
  await sale;
  return res;
}

describe('a partly sold LOOSE lot', () => {
  it('stock transfer → 409; after the bill is deleted with its stock it moves', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: s.lot, gross: 5, pcs: 1, rate: 60000 }] }));
    await expect(s.move()).rejects.toMatchObject({ status: 409 });
    expect((await lotRow(s)).branchId).toBe(s.root.id);
    await billing.deleteBill(s.ctx, bill.id, true); // the 5 g comes back to the lot in its own branch
    await s.move();
    const after = await lotRow(s);
    expect([after.branchId, Number(after.gross)]).toEqual([s.child.id, 20]);
  });

  it('owner rule: the 409 names the live bill; a bill deleted WITHOUT its stock no longer holds the lot — it moves with what is left (15 g)', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: s.lot, gross: 5, pcs: 1, rate: 60000 }] }));
    await expect(s.move()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`has a sale on live bill ${bill.billNo}`) });
    await billing.deleteBill(s.ctx, bill.id, false); // the 5 g stays sold
    await s.move();
    const after = await lotRow(s);
    expect([after.branchId, Number(after.gross)]).toEqual([s.child.id, 15]);
  });

  it('race: a sale that commits while the transfer waits on the row → 409, the lot stays (15 g, root branch)', async () => {
    const s = await setup();
    expect(await duringSale(s, s.move)).toMatchObject({ status: 409 });
    const after = await lotRow(s);
    expect([after.branchId, Number(after.gross)]).toEqual([s.root.id, 15]);
  });

  it('race: same for delete → 409, the lot stays AVAILABLE', async () => {
    const s = await setup();
    expect(await duringSale(s, () => inv.deleteStock(s.ctx, s.lot))).toMatchObject({ status: 409 });
    const after = await lotRow(s);
    expect([after.status, Number(after.gross)]).toEqual(['AVAILABLE', 15]);
  });

  it('race: same for edit → 409, the sale is not overwritten', async () => {
    const s = await setup();
    expect(await duringSale(s, () => inv.updateStock(s.ctx, s.lot, { gross: 18 }))).toMatchObject({ status: 409 });
    expect(Number((await lotRow(s)).gross)).toBe(15);
  });

  it('race (G7 G): an edit that read the lot while it was sold, and waits while the bill is deleted with its stock, keeps the returned grams', async () => {
    const s = await setup();
    const bill = await billing.createBill(s.ctx, billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ stockItemId: s.lot, gross: 5, pcs: 1, rate: 60000 }] }));
    expect(Number((await lotRow(s)).gross)).toBe(15);
    let returning!: () => void;
    const inFlight = new Promise<void>((r) => (returning = r));
    // the bill deleted with its stock, mid-flight: the 5 g back on the lot and the bill's stock row reversed — committed once the edit waits on the lot
    const del = db.$transaction(async (t) => {
      await t.bill.update({ where: { id: bill.id }, data: { status: 'DELETED', deletedAt: new Date(), deletedWithStock: true } });
      await t.stockItem.update({ where: { id: s.lot }, data: { gross: { increment: 5 }, net: { increment: 5 }, pcs: { increment: 1 } } });
      await ledger.reverse(t, { businessId: s.business.id, branchIds: [s.root.id], userId: 1 }, { source: 'SELL_BILL', sourceId: String(bill.id) });
      returning();
      await lockWaiter();
    });
    await inFlight;
    const edit = inv.updateStock(s.ctx, s.lot, { remarks: 'checked' });
    await del;
    await edit;
    const after = await lotRow(s);
    expect([Number(after.gross), after.remarks]).toEqual([20, 'checked']);
  });
});
