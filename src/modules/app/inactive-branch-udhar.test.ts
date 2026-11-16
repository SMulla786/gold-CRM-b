/* eslint-disable @typescript-eslint/no-explicit-any -- service inputs are zod-parsed upstream; tests pass partial bodies */
import { beforeEach, expect, it } from 'vitest';
import { api, bearer, loginAs } from '../../../test/helpers/app';
import { db, truncateAll } from '../../../test/helpers/db';
import { createBranch, createBusiness, createPlan, createSubscription, createUser, TEST_MPIN } from '../../../test/helpers/factory';
import { billBody, exchangeBody, girviBody, justBillBody, kachaProcessBody, openingBalanceBody, udharBody } from '../../shared';
import * as billing from './billing/service';
import * as girvi from './girvi/service';
import * as inv from './inventory';
import * as jb from './justbill/service';
import * as orders from './orders/service';
import * as schemes from './schemes/service';
import * as exchange from './trade/exchange';
import * as kacha from './trade/kacha';
import * as udharSvc from './udhar';
import { createOpeningBalances } from './opening';
import type { TenantContext } from '../../middleware/context';

/**
 * G7 closure (A3): an inactive branch takes no new writes (G7 review 3) — also (1) when the write's only rows are party-balance
 * (UdharEntry) rows, which lib/udhar posts / reverses (lib/ledger already refused), and (2) when it posts no row at all and only
 * flips a status. Each write is sent through X-Branch-Id 'all' and through another, active branch (the root): 403
 * BRANCH_INACTIVE, and every row count, status and audit row stays as it was. Once the branch is active again each request is a
 * valid write.
 */

beforeEach(truncateAll);
const MODS = ['dashboard', 'billing', 'orders', 'udhari', 'girvi', 'schemes', 'exchange', 'inventory', 'daybook', 'settings'];
const INACTIVE = { code: 'BRANCH_INACTIVE', message: expect.stringMatching(/"Station Road" is inactive/) };

async function branchSetup() {
  const plan = await createPlan({ modules: MODS });
  const { business, root } = await createBusiness();
  await createSubscription({ businessId: business.id, planId: plan.id, modules: MODS });
  const shop = await createBranch({ businessId: business.id, parentId: root.id, name: 'Station Road' });
  const owner = await createUser({ businessId: business.id, branchId: root.id, level: 'ADMIN', isOwner: true, mpin: TEST_MPIN });
  const { token } = await loginAs(owner.username);
  const party = await db.party.create({ data: { businessId: business.id, type: 'CUSTOMER', name: 'Cust', mobile: '9000000001', countryCode: '+91' } });
  const h = (branch: number | 'all') => ({ Authorization: bearer(token!), 'X-Branch-Id': String(branch), 'X-MPIN': TEST_MPIN });
  /** the shop's own documents are made while it is active, from a context on the shop */
  const shopCtx = { userId: owner.user.id, level: 'ADMIN', isOwner: true, businessId: business.id, scopeBranchId: root.id, branchIds: [root.id, shop.id], activeBranchId: shop.id, readOnly: false, modules: MODS, limits: null, permissions: {}, impersonatorId: null } as TenantContext;
  return { business, root, shop, party, h, shopCtx, off: () => db.branch.update({ where: { id: shop.id }, data: { isActive: false } }), on: () => db.branch.update({ where: { id: shop.id }, data: { isActive: true } }) };
}
type S = Awaited<ReturnType<typeof branchSetup>>;

/** Every row a refused write could have touched. */
const counts = async (s: S) => ({
  udhar: await db.udharEntry.count({ where: { businessId: s.business.id } }),
  ledger: await db.ledgerEntry.count({ where: { businessId: s.business.id } }),
  bills: (await db.bill.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' } })).map((b) => [b.status, String(b.final)]),
  justBills: (await db.justBill.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' } })).map((b) => b.status),
  udharTxns: (await db.udharTxn.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' } })).map((t) => [t.isDeleted, String(t.bhavAmount)]),
  girviTxns: await db.girviTxn.count({ where: { batch: { businessId: s.business.id } } }),
  girviItems: (await db.girviItem.findMany({ where: { batch: { businessId: s.business.id } }, orderBy: { id: 'asc' } })).map((i) => i.status),
  schemePayments: (await db.schemePayment.findMany({ where: { enrollment: { businessId: s.business.id } }, orderBy: { id: 'asc' } })).map((p) => [p.medium, p.isReversed]),
  enrollments: (await db.schemeEnrollment.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' } })).map((e) => e.status),
  processes: (await db.kachaProcess.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' } })).map((p) => p.reverted),
  karigarIssues: (await db.karigarIssue.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' } })).map((k) => k.status),
  orders: (await db.order.findMany({ where: { businessId: s.business.id }, orderBy: { id: 'asc' }, include: { items: { orderBy: { id: 'asc' } } } })).map((o) => [o.status, o.items.map((i) => i.status)]),
  stock: await db.stockItem.count({ where: { businessId: s.business.id } }),
  activity: await db.activityLog.count({ where: { businessId: s.business.id } }),
});

type Write = [name: string, method: 'post' | 'put' | 'patch' | 'delete', path: string, body: object, onlyAll?: true];

/** Sends each write through 'all' and through the root while the shop is inactive (403, nothing changes), then again once it is active (a valid write). */
async function refusedThenValid(s: S, writes: Write[]) {
  const send = (w: Write, via: number | 'all') => api[w[1]](w[2]).set(s.h(via)).send(w[3]);
  const before = await counts(s);
  await s.off();
  for (const w of writes) {
    const r = await send(w, 'all');
    expect([w[0], 'all', r.status, r.body.error]).toEqual([w[0], 'all', 403, expect.objectContaining(INACTIVE)]);
    const other = await send(w, s.root.id);
    // through another branch: refused as inactive, or (a write scoped to the selected branch) not found there at all
    expect([w[0], s.root.id, other.status, other.body.error?.code]).toEqual([w[0], s.root.id, w[4] ? 404 : 403, w[4] ? 'NOT_FOUND' : 'BRANCH_INACTIVE']);
  }
  expect(await counts(s)).toEqual(before);
  await s.on();
  for (const w of writes) {
    const r = await send(w, 'all');
    expect([w[0], r.status < 300, r.status < 300 ? '' : JSON.stringify(r.body)]).toEqual([w[0], true, '']); // each one is a real, valid write
  }
  return counts(s);
}

it("writes that book only party rows on an inactive branch's document → 403 via 'all' and via another branch; nothing is written", async () => {
  const s = await branchSetup();
  const credit = billBody.parse({ kind: 'SELL', billType: 'ROUGH', partyId: s.party.id, items: [{ description: 'Repair work', stockClass: 'SILVER', gross: 0, other: 500 }] });
  const bill = await billing.createBill(s.shopCtx, credit); // no stock line, no payment: its only rows are the party's +500
  const billToEdit = await billing.createBill(s.shopCtx, credit);
  const bhav = { partyId: s.party.id, bhav: { direction: 'MONEY_TO_METAL', metal: 'GOLD', amount: 6000, rate: 60000, unitGrams: 10 } };
  const cut = await udharSvc.createUdharTxn(s.shopCtx, udharBody.parse(bhav)); // a bhav cut moves no shop asset
  const cutToEdit = await udharSvc.createUdharTxn(s.shopCtx, udharBody.parse(bhav));
  const opening = await createOpeningBalances(s.shopCtx, openingBalanceBody.parse({ entries: [{ kind: 'PARTY', partyId: s.party.id, amount: 1000 }] }));
  const just = await jb.createJustBill(s.shopCtx, justBillBody.parse({ partyId: s.party.id, items: [{ name: 'Coin', quantity: 1, unit: 'PCS', rate: 20000 }] }));
  const scheme = await schemes.createScheme(s.shopCtx, { kind: 'SAVING', type: 'CASH', name: 'Saver', emiAmount: 1000, tenureMonths: 12, bonusType: 'NONE', bonusValue: 0, startDate: new Date() } as any);
  const toRedeem = await schemes.enroll(s.shopCtx, { schemeId: scheme.id, partyId: s.party.id, assignId: 'S1', displayName: 'C', tokenAmount: 0 } as any);
  await schemes.addPayment(s.shopCtx, { enrollmentId: toRedeem.id, emiNo: 1, amount: 1000, medium: 'DRAW' } as any); // ₹1,000 counted, no money moved

  const after = await refusedThenValid(s, [
    ['credit-only bill delete', 'delete', `/api/app/bills/${bill.id}?returnStock=false`, {}],
    ['credit-only bill edit', 'patch', `/api/app/bills/${billToEdit.id}`, { ...credit, items: [{ ...credit.items[0], other: 600 }] }],
    ['bhav-cut udhar delete', 'delete', `/api/app/udhar/${cut.id}`, {}],
    ['bhav-cut udhar edit', 'put', `/api/app/udhar/${cutToEdit.id}`, { ...bhav, bhav: { ...bhav.bhav, amount: 12000 } }],
    ['party-only opening delete', 'delete', `/api/app/opening-balances/${opening.sourceId}`, {}, true], // scoped to the selected branch: from another one it is a 404
    ['credit-only just bill delete', 'delete', `/api/app/just-bills/${just.id}`, {}],
    ['scheme redeem (the party credit only)', 'post', `/api/app/schemes/enrollments/${toRedeem.id}/redeem`, { early: true }],
  ]);
  expect([after.bills, after.justBills, after.udharTxns, after.enrollments]).toEqual([
    [['DELETED', '500'], ['ACTIVE', '600']], ['DELETED'], [[true, '6000'], [false, '12000']], ['WITHDRAWN'],
  ]);
});

it("writes that post no row at all on an inactive branch's document (status flips) → 403 via 'all' and via another branch; nothing is written", async () => {
  const s = await branchSetup();
  const loan = await girvi.createGirvi(s.shopCtx, girviBody.parse({
    partyId: s.party.id, issueDate: new Date(), items: [{ category: 'Gold', name: 'Chain', gross: 12, net: 10, purity: 91.67, rate: 6000 }, { category: 'Gold', name: 'Ring', gross: 6, net: 5, purity: 91.67, rate: 6000 }],
    principal: 10000, ratePercent: 2, ratePeriod: 'MONTHLY', interestType: 'SI', method: 'DAY_WISE', tenureMonths: 6, cash: 10000, online: 0,
  }));
  const scheme = await schemes.createScheme(s.shopCtx, { kind: 'SAVING', type: 'CASH', name: 'Saver', emiAmount: 1000, tenureMonths: 12, bonusType: 'NONE', bonusValue: 0, startDate: new Date() } as any);
  const enroll = (assignId: string) => schemes.enroll(s.shopCtx, { schemeId: scheme.id, partyId: s.party.id, assignId, displayName: 'C', tokenAmount: 0 } as any);
  const vendor = await enroll('S2');
  const vendorPay = await schemes.addPayment(s.shopCtx, { enrollmentId: vendor.id, emiNo: 1, amount: 1000, medium: 'VENDOR' } as any); // counted as paid, no money moved
  const toWin = await enroll('S3');
  const toDraw = await enroll('S4');
  const empty = await enroll('S5'); // nothing paid: a withdrawal is worth ₹0, so it writes no party row
  const bought = await exchange.createExchange(s.shopCtx, exchangeBody.parse({ partyId: s.party.id, metal: 'GOLD', side: 'BUY', lines: [{ weight: 10, touch: 100 }], rate: 0 }));
  const batch = await kacha.processKacha(s.shopCtx, kachaProcessBody.parse({ type: 'PROCESS', metal: 'GOLD', exchangeIds: [bought.id] })); // reserves, posts no row
  const [group] = await inv.createItemGroups(s.shopCtx, { stockClass: 'GOLD', names: ['Rings'], gstRate: 3 });
  const ring = (await inv.createItemName(s.shopCtx, { groupId: group!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 }))!;
  const order = await orders.createOrder(s.shopCtx, { partyId: s.party.id, rateType: 'ON_DELIVERY', isUrgent: false, items: [{ itemNameId: ring.id, metal: 'GOLD', karatCode: '22K', gross: 10, making: 0, makingUnit: 'PER_GRAM', pcs: 1 }], payments: [] } as any);
  const karigar = await db.party.create({ data: { businessId: s.business.id, type: 'KARIGAR', name: 'Kari', mobile: '9000000004', countryCode: '+91' } });
  const issue = await orders.createKarigarIssue(s.shopCtx, { karigarId: karigar.id, orderItemIds: [order.items[0]!.id], goldFine: 0, silverFine: 0, cash: 0, online: 0 } as any);

  const after = await refusedThenValid(s, [
    ['girvi release of ₹0', 'post', `/api/app/girvi/${loan.id}/release`, { itemIds: [loan.items[0]!.id], principalPaid: 0, interestPaid: 0, cash: 0, online: 0 }],
    ['VENDOR scheme payment reversal', 'post', `/api/app/schemes/payments/${vendorPay.payments[0]!.id}/reverse`, {}, true], // scoped to the selected branch
    ['DRAW scheme payment', 'post', '/api/app/schemes/payments', { enrollmentId: toDraw.id, amount: 1000, medium: 'DRAW' }],
    ['scheme enrollment marked won', 'post', `/api/app/schemes/enrollments/${toWin.id}/won`, {}],
    ['scheme redeem worth ₹0', 'post', `/api/app/schemes/enrollments/${empty.id}/redeem`, { early: true }],
    ['kacha process batch reverted', 'post', `/api/app/kacha/${batch.id}/revert`, {}],
    ['karigar issue received', 'post', `/api/app/karigar-issues/${issue.id}/receive`, { items: [{ orderItemId: order.items[0]!.id, returnedGross: 10, tagNo: 'K0001' }] }],
  ]);
  expect([after.girviItems, after.schemePayments, after.enrollments, after.processes, after.karigarIssues, after.orders]).toEqual([
    ['RELEASED', 'PLEDGED'], [['VENDOR', true], ['DRAW', false]], ['ACTIVE', 'WON', 'ACTIVE', 'WITHDRAWN'], [true], ['RECEIVED'], [['READY', ['RECEIVED']]],
  ]);
});
