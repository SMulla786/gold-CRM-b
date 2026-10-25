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
