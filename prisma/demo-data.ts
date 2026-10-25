/**
 * Demo transactional data for the "Demo Jewellers" business — run AFTER the normal seed (db:seed with SEED_DEMO=true).
 * Everything goes THROUGH the service functions (not raw inserts) so ledger + udhar + stock stay consistent.
 * Idempotent: skips if the business already has bills. Dates are spread over the last ~30 days where a service takes a txnDate.
 *
 *   npm run seed:demo-data
 */
import { prisma } from '../src/lib/prisma';
import { MODULE_KEYS } from '../src/shared';
import type { TenantContext } from '../src/middleware/context';
import { billBody, incomeExpenseBody, udharBody } from '../src/shared';
import * as app from '../src/modules/app/service';
import * as inv from '../src/modules/app/inventory';
import * as accounts from '../src/modules/app/accounts';
import * as billing from '../src/modules/app/billing/service';
import * as udhar from '../src/modules/app/udhar';

const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

async function main() {
  const biz = await prisma.business.findFirst({ where: { name: 'Demo Jewellers' } });
  if (!biz) {
    console.log('Demo Jewellers not found — run the normal seed first (SEED_DEMO=true npm run db:seed). Skipping.');
    return;
  }
  if ((await prisma.bill.count({ where: { businessId: biz.id } })) > 0) {
    console.log('Demo data already present (bills exist) — skipping.');
    return;
  }

  const owner = await prisma.user.findFirstOrThrow({ where: { businessId: biz.id, isOwner: true } });
  const branches = await prisma.branch.findMany({ where: { businessId: biz.id }, select: { id: true, name: true } });
  const branchIds = branches.map((b) => b.id);
  const byName = (n: string) => branches.find((b) => b.name === n)!.id;
  const HQ = byName('Demo HQ');
  const PUNE = byName('Pune');
  const KOTHRUD = byName('Kothrud');

  /** Owner context acting in one branch (ADMIN sees the whole subtree; activeBranchId picks the working branch). */
  const ctxAt = (branchId: number): TenantContext => ({
    userId: owner.id, level: 'ADMIN', isOwner: true, businessId: biz.id, scopeBranchId: HQ, branchIds, activeBranchId: branchId,
    readOnly: false, modules: MODULE_KEYS as unknown as string[], limits: null, permissions: {}, impersonatorId: null,
  });
  const hq = ctxAt(HQ);
  const pune = ctxAt(PUNE);
  const kothrud = ctxAt(KOTHRUD);

  // ── Rates (today) ──────────────────────────────────────────────
  const goldKarats = await prisma.karatMapping.findMany({ where: { businessId: biz.id, metal: 'GOLD' }, orderBy: { sort: 'asc' } });
  const silverKarats = await prisma.karatMapping.findMany({ where: { businessId: biz.id, metal: 'SILVER' }, orderBy: { sort: 'asc' } });
  const k22 = goldKarats.find((k) => k.code.includes('22'))?.code ?? goldKarats[0]!.code;
  const silverCode = silverKarats[0]?.code ?? 'SILVER';
  // Wide demo rate bands so the demo sell rates (gold 60000/10g, silver 78000/kg) pass the per-line limit check.
  await app.putRateLimits(hq, [{ metal: 'GOLD', rateUnit: 'GRAM_10', minRate: 40000, maxRate: 90000 }, { metal: 'SILVER', rateUnit: 'KG_1', minRate: 50000, maxRate: 120000 }]);
  await app.setRates(hq, { metal: 'GOLD', rateUnit: 'GRAM_10', rates: goldKarats.map((k) => ({ karatCode: k.code, sellRate: Math.round(63000 * (Number(k.touch) / 100)), buyRate: Math.round(63000 * (Number(k.touch) / 100)) - 1500 })) });
  if (silverKarats.length) await app.setRates(hq, { metal: 'SILVER', rateUnit: 'KG_1', rates: silverKarats.map((k) => ({ karatCode: k.code, sellRate: 78000, buyRate: 75000 })) });

  // ── Masters: groups + item names (GOLD + SILVER, TAG + LOOSE) ───
  const [goldGroup] = await inv.createItemGroups(hq, { stockClass: 'GOLD', names: ['Gold Jewellery'], gstRate: 3 });
  const [silverGroup] = await inv.createItemGroups(hq, { stockClass: 'SILVER', names: ['Silver Articles'], gstRate: 3 });
  const goldRing = await inv.createItemName(hq, { groupId: goldGroup!.id, name: 'Gold Ring', method: 'TAG', tagPrefix: 'GR', tagDigits: 4 });
  const goldChain = await inv.createItemName(hq, { groupId: goldGroup!.id, name: 'Gold Chain', method: 'TAG', tagPrefix: 'GC', tagDigits: 4 });
  const goldBar = await inv.createItemName(hq, { groupId: goldGroup!.id, name: 'Gold Bar', method: 'LOOSE' });
  const silverCoin = await inv.createItemName(hq, { groupId: silverGroup!.id, name: 'Silver Coin', method: 'TAG', tagPrefix: 'SC', tagDigits: 4 });
  const silverBar = await inv.createItemName(hq, { groupId: silverGroup!.id, name: 'Silver Bar', method: 'LOOSE' });

  const tagRow = (itemNameId: number, karatCode: string, gross: number, cost: number) => ({ itemNameId, karatCode, pcs: 1, gross, less: 0, wastage: 2, stoneCharge: 0, labour: 500, labourUnit: 'PER_GRAM', other: 0, purchaseCost: cost });
  const looseRow = (itemNameId: number, karatCode: string, gross: number, cost: number) => ({ itemNameId, karatCode, pcs: 1, gross, less: 0, wastage: 0, stoneCharge: 0, labour: 0, labourUnit: 'PER_GRAM', other: 0, purchaseCost: cost });
  const entry = async (ctx: TenantContext, branchId: number, stockClass: 'GOLD' | 'SILVER', method: 'TAG' | 'LOOSE', rows: Record<string, unknown>[], dAgo: number) =>
    (await inv.createStockEntry(ctx, { stockClass, method, branchId, txnDate: daysAgo(dAgo), rows })).items.map((i) => i.id);

  // ~21 stock items across HQ / Pune / Kothrud
  const hqRings = await entry(hq, HQ, 'GOLD', 'TAG', [tagRow(goldRing!.id, k22, 8, 44000), tagRow(goldRing!.id, k22, 10, 55000), tagRow(goldRing!.id, k22, 9, 49500), tagRow(goldRing!.id, k22, 11, 60500), tagRow(goldRing!.id, k22, 7.5, 41000)], 28);
  const hqChains = await entry(hq, HQ, 'GOLD', 'TAG', [tagRow(goldChain!.id, k22, 15, 82500), tagRow(goldChain!.id, k22, 20, 110000)], 27);
  await entry(hq, HQ, 'GOLD', 'LOOSE', [looseRow(goldBar!.id, k22, 100, 550000)], 27);
  const puneRings = await entry(pune, PUNE, 'GOLD', 'TAG', [tagRow(goldRing!.id, k22, 9, 49500), tagRow(goldRing!.id, k22, 12, 66000), tagRow(goldRing!.id, k22, 8.5, 46750)], 25);
  await entry(pune, PUNE, 'SILVER', 'TAG', [tagRow(silverCoin!.id, silverCode, 50, 3900), tagRow(silverCoin!.id, silverCode, 100, 7800), tagRow(silverCoin!.id, silverCode, 25, 1950)], 24);
  await entry(pune, PUNE, 'SILVER', 'LOOSE', [looseRow(silverBar!.id, silverCode, 1000, 75000)], 24);
  await entry(kothrud, KOTHRUD, 'GOLD', 'TAG', [tagRow(goldRing!.id, k22, 10, 55000), tagRow(goldRing!.id, k22, 6, 33000), tagRow(goldRing!.id, k22, 14, 77000)], 22);
  const kothrudCoins = await entry(kothrud, KOTHRUD, 'SILVER', 'TAG', [tagRow(silverCoin!.id, silverCode, 75, 5850), tagRow(silverCoin!.id, silverCode, 40, 3120)], 22);
  await entry(kothrud, KOTHRUD, 'GOLD', 'LOOSE', [looseRow(goldBar!.id, k22, 50, 275000)], 22);

  // ── Parties (customers / suppliers / karigar) ──────────────────
  const party = async (type: 'CUSTOMER' | 'SUPPLIER' | 'KARIGAR', name: string, mobile: string) => (await app.createParty(hq, { type, name, mobile, countryCode: '+91' })).dto.id;
  const rahul = await party('CUSTOMER', 'Rahul Shah', '9000000011');
  const priya = await party('CUSTOMER', 'Priya Mehta', '9000000012');
  const amit = await party('CUSTOMER', 'Amit Jain', '9000000013');
  const sneha = await party('CUSTOMER', 'Sneha Patil', '9000000014');
  await party('CUSTOMER', 'Vikram Rao', '9000000018');
  const goldTraders = await party('SUPPLIER', 'Mumbai Gold Traders', '9000000015');
  await party('SUPPLIER', 'Pune Bullion', '9000000016');
  await party('KARIGAR', 'Karigar Suresh', '9000000017');

  // ── Bank account (for online payments) ─────────────────────────
  await app.createBankAccount(hq, { branchId: 0, bankName: 'HDFC Bank', accountNo: '50100123456', ifsc: 'HDFC0001234', applyTo: 'ALL', isActive: true });
  const bankId = (await prisma.bankAccount.findFirstOrThrow({ where: { businessId: biz.id, accountNo: '50100123456' } })).id;

  // ── Purchase bill (creates new stock at HQ) ────────────────────
  await billing.createBill(hq, billBody.parse({
    kind: 'PURCHASE', billType: 'GST', partyId: goldTraders, billDate: daysAgo(20), gstPercent: 3,
    items: [{ itemNameId: goldRing!.id, gross: 10, karatCode: k22, rate: 5200 }, { itemNameId: goldChain!.id, gross: 18, karatCode: k22, rate: 5200 }],
    payments: [{ mode: 'ONLINE', amount: 100000, bankAccountId: bankId }],
  }));

  // ── Sell bills ─────────────────────────────────────────────────
  // 1) GST, mixed cash + online + metal payment, small pending
  await billing.createBill(hq, billBody.parse({
    kind: 'SELL', billType: 'GST', partyId: rahul, billDate: daysAgo(12), gstPercent: 3, items: [{ stockItemId: hqRings[0], gross: 10, rate: 60000 }],
    payments: [{ mode: 'CASH', amount: 30000 }, { mode: 'ONLINE', amount: 20000, bankAccountId: bankId }, { mode: 'METAL', metal: 'GOLD', metalForm: 'BULLION', gross: 2, tunch: 91.67, rate: 60000 }],
  }));
  // 2) ROUGH, balance kept as GOLD
  await billing.createBill(pune, billBody.parse({
    kind: 'SELL', billType: 'ROUGH', partyId: priya, billDate: daysAgo(10), items: [{ stockItemId: puneRings[0], gross: 9, rate: 60000 }],
    payments: [{ mode: 'CASH', amount: 20000 }], keepBalanceAs: 'GOLD', keepRate: 60000,
  }));
  // 3) GST silver sale, fully paid cash
  await billing.createBill(kothrud, billBody.parse({
    kind: 'SELL', billType: 'GST', partyId: amit, billDate: daysAgo(7), gstPercent: 3, items: [{ stockItemId: kothrudCoins[0], gross: 75, rate: 78000 }],
    payments: [{ mode: 'CASH', amount: 6500 }],
  }));
  // 4) GST, partial cash → pending money balance (settled by an udhar txn below)
  const pendingBill = await billing.createBill(hq, billBody.parse({
    kind: 'SELL', billType: 'GST', partyId: sneha, billDate: daysAgo(4), gstPercent: 3, items: [{ stockItemId: hqChains[0], gross: 15, rate: 60000 }],
    payments: [{ mode: 'CASH', amount: 20000 }],
  }));

  // ── Udhar txns ─────────────────────────────────────────────────
  // bhav cut: convert ₹50,000 of Rahul's balance into gold at 60000/10g
  await udhar.createUdharTxn(hq, udharBody.parse({ partyId: rahul, txnDate: daysAgo(3), bhav: { direction: 'MONEY_TO_METAL', metal: 'GOLD', amount: 50000, rate: 60000, unitGrams: 10 }, remark: 'Bhav cut — money to gold' }));
  // settle the pending sell bill with cash received
  await udhar.createUdharTxn(hq, udharBody.parse({ partyId: sneha, txnDate: daysAgo(2), cashIn: Number(pendingBill.balance), settleBillId: pendingBill.id, remark: 'Settled pending bill' }));

  // ── Income / Expense ───────────────────────────────────────────
  await accounts.createIncomeExpense(hq, incomeExpenseBody.parse({ type: 'INCOME', reason: 'Old silver scrap sale', cash: 5000, txnDate: daysAgo(6) }));
  await accounts.createIncomeExpense(hq, incomeExpenseBody.parse({ type: 'EXPENSE', reason: 'Shop supplies & tea', cash: 2000, txnDate: daysAgo(5) }));

  // ── Stock transfer HQ → Pune (one spare HQ ring) ───────────────
  await inv.createStockTransfer(hq, { fromBranchId: HQ, toBranchId: PUNE, stockItemIds: [hqRings[1]!], remarks: 'Rebalance stock to Pune' });

  console.log(`Demo data seeded for "${biz.name}": ~21 stock items, 8 parties, 1 purchase + 4 sell bills, 2 udhar, 2 income/expense, 1 transfer.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
