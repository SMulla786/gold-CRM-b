// Baseline self-check by lead (hand-computed with the fixture-verified formulas).
import { describe, expect, it } from 'vitest';
import { computeBill, computeJustLine, computeLine, girviDue, girviEffectiveRate, girviInterest, metalToMoney, moneyToMetal, schemeMaturity } from './index';

describe('computeLine', () => {
  it('22K ring: multiplicative wastage, per-gram labour on gross, % discount on metal', () => {
    const r = computeLine({
      gross: '10.500',
      less: '0.500',
      tunch: '91.67',
      wastage: '2',
      rate: '130000', // per 10 g
      rateUnitGrams: 10,
      labour: '500',
      labourUnit: 'PER_GRAM',
      stoneCharge: '1000',
      other: '100',
      discount: '1',
      discountUnit: 'PERCENT',
    });
    expect(r.net).toBe('10.000');
    expect(r.fine).toBe('9.350'); // 10 × 0.9167 × 1.02
    expect(r.metalAmount).toBe('130000.00');
    expect(r.labourAmount).toBe('5250.00'); // 500 × gross 10.5
    expect(r.discountAmount).toBe('1300.00'); // 1% of metal
    expect(r.total).toBe('135050.00');
  });

  it('percent labour is on gross × per-gram rate; FINE basis drives metal amount', () => {
    const r = computeLine({ gross: 10, tunch: 75, rate: 1000, labour: 10, labourUnit: 'PERCENT', basis: 'FINE' });
    expect(r.basisWeight).toBe('7.500');
    expect(r.metalAmount).toBe('7500.00');
    expect(r.labourAmount).toBe('1000.00');
    expect(r.total).toBe('8500.00');
  });
});

describe('computeBill', () => {
  it('intra-state 3% GST split, rounding to rupee', () => {
    const r = computeBill({ lineTotals: ['10000.40', '5000.00'], gstPercent: 3 });
    expect(r.sub).toBe('15000.40');
    expect(r.cgst).toBe('225.01');
    expect(r.sgst).toBe('225.01');
    expect(r.total).toBe('15450.42'); // = taxable + displayed cgst + sgst
    expect(r.final).toBe('15450.00');
    expect(r.round).toBe('-0.42');
  });

  it('inter-state IGST, fixed discount, GST exempt metal amount', () => {
    const r = computeBill({ lineTotals: [100000], discount: 1000, gstPercent: 3, interState: true, gstExemptAmount: 50000 });
    expect(r.taxable).toBe('49000.00');
    expect(r.igst).toBe('1470.00');
    expect(r.final).toBe('100470.00');
  });
});

describe('conversions', () => {
  it('money <-> metal at rate per 10 g', () => {
    expect(moneyToMetal(13000, 130000, 10)).toBe('1.000');
    expect(metalToMoney('2.5', 130000, 10)).toBe('32500.00');
  });
});

describe('computeJustLine', () => {
  it('GRAM line with per-gram making', () => {
    expect(computeJustLine({ quantity: '10.5', unit: 'GRAM', rate: 6000, making: 500, makingUnit: 'PER_GRAM', other: 100 })).toEqual({ amount: '63000.00', making: '5250.00', total: '68350.00' });
  });
  it('PCS line with percent and fixed making', () => {
    expect(computeJustLine({ quantity: 2, unit: 'PCS', rate: 1500, making: 10, makingUnit: 'PERCENT' })).toEqual({ amount: '3000.00', making: '300.00', total: '3300.00' });
    expect(computeJustLine({ quantity: 2, unit: 'PCS', rate: 1500, making: 250, makingUnit: 'FIXED' }).total).toBe('3250.00');
  });
  it('per-gram making on a PCS line is an error', () => {
    expect(() => computeJustLine({ quantity: 1, unit: 'PCS', rate: 100, making: 5, makingUnit: 'PER_GRAM' })).toThrow();
  });
});

describe('girviInterest', () => {
  const base = { principal: 100000, ratePercent: 2, ratePeriod: 'MONTHLY' as const, from: '2026-01-15' };
  it('SI day-wise: 2%/month for 45 days = 1.5 months', () => {
    expect(girviInterest({ ...base, interestType: 'SI', method: 'DAY_WISE', to: '2026-03-01' })).toMatchObject({ interest: '3000.00', days: 45 });
  });
  it('SI full-month: a started month counts whole (Jan 15 → Mar 1 = 2 months)', () => {
    expect(girviInterest({ ...base, interestType: 'SI', method: 'FULL_MONTH', to: '2026-03-01' }).interest).toBe('4000.00');
    expect(girviInterest({ ...base, interestType: 'SI', method: 'FULL_MONTH', to: '2026-01-16' }).interest).toBe('2000.00');
  });
  it('annual rate is divided by 12', () => {
    expect(girviInterest({ ...base, ratePercent: 24, ratePeriod: 'ANNUAL', interestType: 'SI', method: 'DAY_WISE', to: '2026-02-14' }).interest).toBe('2000.00');
  });
  it('CI monthly over 12 full months = P((1.02)^12 − 1)', () => {
    expect(girviInterest({ ...base, interestType: 'CI', ciPeriod: 'MONTHLY', method: 'FULL_MONTH', to: '2027-01-15' }).interest).toBe('26824.18');
  });
  it('same day or earlier → zero', () => {
    expect(girviInterest({ ...base, interestType: 'SI', method: 'DAY_WISE', to: '2026-01-15' }).interest).toBe('0.00');
    expect(girviInterest({ ...base, interestType: 'SI', method: 'DAY_WISE', to: '2026-01-01' }).interest).toBe('0.00');
  });
});

describe('schemeMaturity', () => {
  it('CASH 11+1: one EMI bonus', () => {
    const payments = Array.from({ length: 11 }, () => ({ amount: 2000 }));
    expect(schemeMaturity({ type: 'CASH', payments, bonusType: 'ONE_EMI', emiAmount: 2000 })).toEqual({ paid: '22000.00', fine: '0.000', bonus: '2000.00', maturity: '24000.00', maturityValue: '24000.00' });
  });
  it('CASH percent bonus, none when withdrawn early', () => {
    const payments = Array.from({ length: 10 }, () => ({ amount: 5000 }));
    expect(schemeMaturity({ type: 'CASH', payments, bonusType: 'PERCENT', bonusValue: 8, emiAmount: 5000 }).maturity).toBe('54000.00');
    expect(schemeMaturity({ type: 'CASH', payments, bonusType: 'PERCENT', bonusValue: 8, emiAmount: 5000, early: true }).maturity).toBe('50000.00');
  });
  it('GOLD: stored 3-dp fines + 2% bonus valued at the redeem rate (per 10 g)', () => {
    const payments = [60000, 62500, 65000].map((r) => ({ amount: 10000, fine: moneyToMetal(10000, r, 10) }));
    expect(payments.map((p) => p.fine)).toEqual(['1.667', '1.600', '1.538']);
    expect(schemeMaturity({ type: 'GOLD', payments, bonusType: 'PERCENT', bonusValue: 2, emiAmount: 10000, redeemRate: 65000 })).toEqual({ paid: '30000.00', fine: '4.805', bonus: '0.096', maturity: '4.901', maturityValue: '31856.50' });
  });
});

describe('girviDue (owner-approved extras: per-item rate, first-month interest, penalty)', () => {
  const base = { principal: 100000, ratePercent: 2, ratePeriod: 'MONTHLY' as const, interestType: 'SI' as const, method: 'DAY_WISE' as const, issueDate: '2026-01-15', interestFrom: '2026-01-15', returnDate: '2026-07-15' };
  it('no extras = plain girviInterest', () => {
    expect(girviDue({ ...base, to: '2026-03-01' })).toEqual({ interest: '3000.00', regular: '3000.00', firstMonth: '0.00', penalty: '0.00' });
  });
  it('per-item rate: valuation-weighted (3% and loan 2% on equal values = 2.5%)', () => {
    const items = [{ valuation: 100000, ratePercent: 3 }, { valuation: 100000, ratePercent: null }];
    expect(girviEffectiveRate(2, items)).toBe('2.5');
    expect(girviDue({ ...base, items, to: '2026-03-01' }).interest).toBe('3750.00');
  });
  it('first-month fixed interest replaces month one, regular accrues after', () => {
    expect(girviDue({ ...base, firstMonthInterest: 1500, to: '2026-03-01' })).toEqual({ interest: '2433.33', regular: '933.33', firstMonth: '1500.00', penalty: '0.00' });
    expect(girviDue({ ...base, firstMonthInterest: 1500, to: '2026-01-20' }).interest).toBe('1500.00');
  });
  it('first-month interest no longer applies once interest was settled', () => {
    expect(girviDue({ ...base, interestFrom: '2026-02-10', firstMonthInterest: 1500, to: '2026-03-12' }).firstMonth).toBe('0.00');
  });
  it('penalty: simple % per month on principal after the return date', () => {
    expect(girviDue({ ...base, penaltyRatePercent: 1, to: '2026-08-14' })).toEqual({ interest: '15066.67', regular: '14066.67', firstMonth: '0.00', penalty: '1000.00' });
    expect(girviDue({ ...base, penaltyRatePercent: 1, to: '2026-07-01' }).penalty).toBe('0.00');
  });
});

describe('roundMoney (G5 exchange round-off: money only)', () => {
  it('NONE keeps the paisa; NEAREST is half-up to the step; UP / DOWN move the absolute amount; round = final − exact', async () => {
    const { roundMoney } = await import('./index');
    expect(roundMoney(1234.56, 'NONE')).toEqual({ final: '1234.56', round: '0.00' });
    expect(roundMoney(1234.5, 'NEAREST')).toEqual({ final: '1235.00', round: '0.50' });
    expect(roundMoney(1234.49, 'NEAREST')).toEqual({ final: '1234.00', round: '-0.49' });
    expect(roundMoney(1234.01, 'UP')).toEqual({ final: '1235.00', round: '0.99' });
    expect(roundMoney(1234.99, 'DOWN')).toEqual({ final: '1234.00', round: '-0.99' });
    expect(roundMoney(1234, 'UP')).toEqual({ final: '1234.00', round: '0.00' });
    expect(roundMoney(-1234.4, 'UP')).toEqual({ final: '-1235.00', round: '-0.60' }); // absolute goes up
    expect(roundMoney(-1234.6, 'DOWN')).toEqual({ final: '-1234.00', round: '0.60' });
    expect(roundMoney(1234.56, 'NEAREST', 10)).toEqual({ final: '1230.00', round: '-4.56' });
    expect(roundMoney(1235, 'NEAREST', 10)).toEqual({ final: '1240.00', round: '5.00' });
    expect(roundMoney(1234.56, 'UP', 0)).toEqual({ final: '1234.56', round: '0.00' }); // no step → exact
  });
});
