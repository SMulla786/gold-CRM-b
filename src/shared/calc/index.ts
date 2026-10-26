/**
 * Weight / value engine shared by web (live totals) and API (authoritative recompute).
 * Verified against justudhari's own calc functions (32 cases in __fixtures__/justudhari-cases.json):
 *   fine     = net × tunch/100 × (1 + wastage/100)        (wastage is multiplicative, not added to tunch)
 *   metal    = basisWeight × rate / rateUnitGrams          (sell: gold /10 g, silver /1000 g; purchase: /1 g)
 *   labour   = PER_GRAM: gross × lbr | PERCENT: gross × (rate/unit) × lbr% | FIXED: lbr
 *   discount = PERCENT: metal × d% | FIXED: d
 *   line     = metal + stoneCharge + labour + other − discount
 *   bill     = (Σ lines − billDiscount) + GST on that discounted base; final rounded to the rupee.
 * Exact decimal math: justudhari's float rounding can differ by ₹0.01 on intermediate totals (e.g. 4645.815).
 * All inputs/outputs are decimal strings (or numbers) — never rely on JS float math.
 */
import Decimal from 'decimal.js';

export type Num = Decimal.Value;
export type CalcBasis = 'NET' | 'GROSS' | 'FINE';
export type LabourUnit = 'PER_GRAM' | 'PERCENT' | 'FIXED';
export type DiscountUnit = 'FIXED' | 'PERCENT';

const D = (v: Num | undefined | null) => new Decimal(v === undefined || v === null || v === '' ? 0 : v);
const W = (d: Decimal) => d.toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3); // weight
const M = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2); // money

export interface LineInput {
  pcs?: Num;
  gross: Num;
  less?: Num;
  /** purity % (e.g. 91.67 for 22K) */
  tunch?: Num;
  /** wastage % applied on top of the fine (fine × (1 + wastage/100)) */
  wastage?: Num;
  stoneCharge?: Num;
  /** rate per `rateUnitGrams` grams (sell bill: gold per 10 g, silver per 1000 g; purchase bill: per 1 g) */
  rate?: Num;
  rateUnitGrams?: Num;
  /** labour is always computed on gross weight */
  labour?: Num;
  labourUnit?: LabourUnit;
  other?: Num;
  /** line discount; PERCENT is of the metal amount */
  discount?: Num;
  discountUnit?: DiscountUnit;
  /** weight used for the metal amount (shop setting "calculation basis") */
  basis?: CalcBasis;
}

export interface LineResult {
  net: string;
  fine: string;
  basisWeight: string;
  metalAmount: string;
  labourAmount: string;
  discountAmount: string;
  total: string;
}

export function netWeight(gross: Num, less?: Num): Decimal {
  return Decimal.max(D(gross).minus(D(less)), 0);
}

/** fine = net × tunch/100 × (1 + wastage/100) */
export function fineWeight(net: Num, tunch?: Num, wastage?: Num): Decimal {
  return D(net).times(D(tunch)).div(100).times(D(wastage).div(100).plus(1));
}

export function computeLine(i: LineInput): LineResult {
  const net = netWeight(i.gross, i.less);
  const fine = fineWeight(net, i.tunch, i.wastage);
  const basis = i.basis ?? 'NET';
  const basisWt = basis === 'GROSS' ? D(i.gross) : basis === 'FINE' ? fine : net;
  const unit = D(i.rateUnitGrams ?? 1);
  const perGram = unit.isZero() ? new Decimal(0) : D(i.rate).div(unit);
  const gross = D(i.gross);
  const metal = basisWt.times(perGram);
  const lu = i.labourUnit ?? 'PER_GRAM';
  const labour =
    lu === 'PER_GRAM'
      ? gross.times(D(i.labour))
      : lu === 'PERCENT'
        ? gross.times(perGram).times(D(i.labour)).div(100)
        : D(i.labour);
  const beforeDisc = metal.plus(D(i.stoneCharge)).plus(labour).plus(D(i.other));
  const disc = (i.discountUnit ?? 'FIXED') === 'PERCENT' ? metal.times(D(i.discount)).div(100) : D(i.discount);
  return {
    net: W(net),
    fine: W(fine),
    basisWeight: W(basisWt),
    metalAmount: M(metal),
    labourAmount: M(labour),
    discountAmount: M(disc),
    total: M(beforeDisc.minus(disc)),
  };
}

export interface BillInput {
  lineTotals: Num[];
  discount?: Num;
  discountUnit?: DiscountUnit;
  gstPercent?: Num;
  /** true → IGST, false → CGST + SGST (half each) */
  interState?: boolean;
  /** amount excluded from GST base (metal received, when "GST on remaining metal" is on) */
  gstExemptAmount?: Num;
  /** round final to nearest multiple (default 1 rupee); 0 = no rounding */
  roundTo?: Num;
}

export interface BillResult {
  sub: string;
  discountAmount: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  round: string;
  final: string;
}

export function computeBill(b: BillInput): BillResult {
  const sub = b.lineTotals.reduce<Decimal>((a, t) => a.plus(D(t)), new Decimal(0));
  const disc = (b.discountUnit ?? 'FIXED') === 'PERCENT' ? sub.times(D(b.discount)).div(100) : D(b.discount);
  const afterDisc = sub.minus(disc);
  const taxable = Decimal.max(afterDisc.minus(D(b.gstExemptAmount)), 0);
  const gst = taxable.times(D(b.gstPercent)).div(100);
  const half = gst.div(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const [cgst, sgst, igst] = b.interState ? [new Decimal(0), new Decimal(0), gst] : [half, half, new Decimal(0)];
  const total = afterDisc.plus(cgst).plus(sgst).plus(igst);
  const step = D(b.roundTo ?? 1);
  const final = step.isZero() ? total : total.div(step).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(step);
  return {
    sub: M(sub),
    discountAmount: M(disc),
    taxable: M(taxable),
    cgst: M(cgst),
    sgst: M(sgst),
    igst: M(igst),
    total: M(total),
    round: M(final.minus(total)),
    final: M(final),
  };
}

/** Converts a money balance to metal weight at a rate per `rateUnitGrams` (keep balance as gold/silver, bhav cut). */
export function moneyToMetal(amount: Num, rate: Num, rateUnitGrams: Num = 1): string {
  const r = D(rate);
  return r.isZero() ? '0.000' : W(D(amount).times(D(rateUnitGrams)).div(r));
}

export function metalToMoney(weight: Num, rate: Num, rateUnitGrams: Num = 1): string {
  const u = D(rateUnitGrams);
  return u.isZero() ? '0.00' : M(D(weight).times(D(rate)).div(u));
}

export interface JustLineInput {
  quantity: Num;
  unit: 'GRAM' | 'PCS';
  rate?: Num;
  making?: Num;
  makingUnit?: LabourUnit;
  other?: Num;
}

/** Just Bill line (no stock): amount = qty × rate; making PER_GRAM = qty × making (GRAM lines only), PERCENT = % of amount, FIXED = making. */
export function computeJustLine(i: JustLineInput): { amount: string; making: string; total: string } {
  const mu = i.makingUnit ?? 'PER_GRAM';
  if (mu === 'PER_GRAM' && i.unit !== 'GRAM' && !D(i.making).isZero()) throw new Error('Making per gram needs a GRAM line');
  const amount = D(i.quantity).times(D(i.rate));
  const making = mu === 'PER_GRAM' ? D(i.quantity).times(D(i.making)) : mu === 'PERCENT' ? amount.times(D(i.making)).div(100) : D(i.making);
  return { amount: M(amount), making: M(making), total: M(amount.plus(making).plus(D(i.other))) };
}

export interface GirviInterestInput {
  principal: Num;
  /** % per ratePeriod */
  ratePercent: Num;
  ratePeriod: 'MONTHLY' | 'ANNUAL';
  interestType: 'SI' | 'CI';
  ciPeriod?: 'DAILY' | 'MONTHLY' | 'HALF_YEARLY' | 'YEARLY';
  /** FULL_MONTH: any started month counts whole; DAY_WISE: days / 30 */
  method: 'FULL_MONTH' | 'DAY_WISE';
  /** ISO dates (YYYY-MM-DD) — interest accrues from `from` up to `to` */
  from: string;
  to: string;
}

const dayMs = 86_400_000;
const ymd = (s: string) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number) as [number, number, number];
  return { y, m, d, t: Date.UTC(y, m - 1, d) };
};

/** Girvi interest on the outstanding principal between two dates. shortcut: DAY_WISE uses a 30-day month (common shop practice), switch to actual month lengths if a shop asks. */
export function girviInterest(i: GirviInterestInput): { interest: string; months: string; days: number } {
  const a = ymd(i.from);
  const b = ymd(i.to);
  const days = Math.max(0, Math.round((b.t - a.t) / dayMs));
  if (days === 0) return { interest: '0.00', months: '0', days: 0 };
  const months =
    i.method === 'FULL_MONTH'
      ? new Decimal(Math.max(1, (b.y - a.y) * 12 + (b.m - a.m) + (b.d > a.d ? 1 : 0)))
      : new Decimal(days).div(30);
  const monthlyRate = D(i.ratePercent).div(i.ratePeriod === 'ANNUAL' ? 12 : 1).div(100);
  const p = D(i.principal);
  let interest: Decimal;
  if (i.interestType === 'SI') {
    interest = p.times(monthlyRate).times(months);
  } else {
    const cp = i.ciPeriod ?? 'MONTHLY';
    const [r, n] =
      cp === 'DAILY'
        ? [monthlyRate.times(12).div(365), new Decimal(days)]
        : cp === 'MONTHLY'
          ? [monthlyRate, months]
          : cp === 'HALF_YEARLY'
            ? [monthlyRate.times(6), months.div(6)]
            : [monthlyRate.times(12), months.div(12)];
    interest = p.times(r.plus(1).pow(n).minus(1));
  }
  return { interest: M(interest), months: months.toDecimalPlaces(4).toString(), days };
}

/** Owner-approved girvi extras (2026-10-26): per-item rate, first-month fixed interest, penalty after the return date. */
export interface GirviDueInput extends Omit<GirviInterestInput, 'from' | 'to'> {
  /** still-pledged items; an item's own ratePercent overrides the loan rate, weighted by valuation */
  items?: Array<{ valuation: Num; ratePercent?: Num | null }>;
  issueDate: string;
  /** interest is settled up to here */
  interestFrom: string;
  returnDate: string;
  /** as-of date */
  to: string;
  /** fixed interest for the first month; applies only while nothing has been settled (interestFrom = issueDate) */
  firstMonthInterest?: Num;
  /** % per month, simple, on the principal, from max(returnDate, interestFrom) to `to` */
  penaltyRatePercent?: Num;
}

const plusMonths = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** Effective loan rate: valuation-weighted average of item rates (loan rate where an item has none). */
export function girviEffectiveRate(ratePercent: Num, items?: GirviDueInput['items']): string {
  const list = (items ?? []).filter((it) => D(it.valuation).gt(0));
  if (!list.some((it) => it.ratePercent != null && it.ratePercent !== '')) return D(ratePercent).toString();
  const total = list.reduce((a, it) => a.plus(D(it.valuation)), new Decimal(0));
  const weighted = list.reduce((a, it) => a.plus(D(it.valuation).times(it.ratePercent != null && it.ratePercent !== '' ? D(it.ratePercent) : D(ratePercent))), new Decimal(0));
  return weighted.div(total).toDecimalPlaces(4).toString();
}

/** Interest due on a girvi = regular (shared girviInterest at the effective rate) + first-month fixed + penalty. */
export function girviDue(i: GirviDueInput): { interest: string; regular: string; firstMonth: string; penalty: string } {
  const rate = girviEffectiveRate(i.ratePercent, i.items);
  const base = { principal: i.principal, ratePercent: rate, ratePeriod: i.ratePeriod, interestType: i.interestType, ciPeriod: i.ciPeriod, method: i.method };
  let firstMonth = new Decimal(0);
  let regularFrom = i.interestFrom;
  if (D(i.firstMonthInterest).gt(0) && i.interestFrom === i.issueDate && ymd(i.to).t > ymd(i.issueDate).t) {
    firstMonth = D(i.firstMonthInterest);
    regularFrom = plusMonths(i.issueDate, 1);
  }
  const regular = ymd(i.to).t > ymd(regularFrom).t ? D(girviInterest({ ...base, from: regularFrom, to: i.to }).interest) : new Decimal(0);
  let penalty = new Decimal(0);
  if (D(i.penaltyRatePercent).gt(0)) {
    const from = ymd(i.returnDate).t > ymd(i.interestFrom).t ? i.returnDate : i.interestFrom;
    const days = Math.max(0, Math.round((ymd(i.to).t - ymd(from).t) / dayMs));
    penalty = D(i.principal).times(D(i.penaltyRatePercent).div(100)).times(new Decimal(days).div(30));
  }
  return { interest: M(regular.plus(firstMonth).plus(penalty)), regular: M(regular), firstMonth: M(firstMonth), penalty: M(penalty) };
}

export interface SchemeMaturityInput {
  type: 'CASH' | 'GOLD';
  /** non-reversed payments; GOLD: fine = the stored 3-dp grams (passbook = math) */
  payments: Array<{ amount: Num; fine?: Num | null }>;
  bonusType: 'NONE' | 'ONE_EMI' | 'PERCENT' | 'FIXED';
  /** PERCENT: % of paid (₹ or g); FIXED: ₹ (CASH) or g (GOLD) */
  bonusValue?: Num;
  emiAmount: Num;
  /** GOLD: rate on redemption day in settings units */
  redeemRate?: Num;
  /** GOLD settings unit (gold rates are per 10 g) */
  rateUnitGrams?: Num;
  /** withdrawal before maturity → no bonus */
  early?: boolean;
}

/** CASH: maturity in ₹ = paid + bonus. GOLD: maturity in g = Σ fine + bonus g, valued at redeemRate. ONE_EMI on GOLD = one EMI's gold at redeemRate. */
export function schemeMaturity(i: SchemeMaturityInput): { paid: string; fine: string; bonus: string; maturity: string; maturityValue: string } {
  const gold = i.type === 'GOLD';
  const unit = i.rateUnitGrams ?? 10;
  const paid = i.payments.reduce((s, p) => s.plus(D(p.amount)), D(0));
  const base = gold ? i.payments.reduce((s, p) => s.plus(D(p.fine)), D(0)) : paid;
  const v = D(i.bonusValue);
  let bonus = D(0);
  if (!i.early) {
    if (i.bonusType === 'PERCENT') bonus = base.times(v).div(100);
    else if (i.bonusType === 'FIXED') bonus = v;
    else if (i.bonusType === 'ONE_EMI') bonus = gold ? D(moneyToMetal(i.emiAmount, i.redeemRate ?? 0, unit)) : D(i.emiAmount);
  }
  const R = gold ? W : M;
  const b = R(bonus);
  const maturity = R(base.plus(b));
  return { paid: M(paid), fine: gold ? W(base) : '0.000', bonus: b, maturity, maturityValue: gold ? metalToMoney(maturity, i.redeemRate ?? 0, unit) : maturity };
}
