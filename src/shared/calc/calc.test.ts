// Baseline self-check by lead (hand-computed). tester adds justudhari fixture cases (TASK-10) alongside.
import { describe, expect, it } from 'vitest';
import { computeBill, computeLine, metalToMoney, moneyToMetal } from './index';

describe('computeLine', () => {
  it('22K ring: net, fine, per-gram labour, stone charge, % discount', () => {
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
    expect(r.fine).toBe('9.367'); // 10 × 93.67%
    expect(r.metalAmount).toBe('130000.00');
    expect(r.labourAmount).toBe('5000.00');
    expect(r.discountAmount).toBe('1361.00'); // 1% of 136100
    expect(r.total).toBe('134739.00');
  });

  it('percent labour is on metal amount; FINE basis uses fine weight', () => {
    const r = computeLine({ gross: 10, tunch: 75, rate: 1000, labour: 10, labourUnit: 'PERCENT', basis: 'FINE' });
    expect(r.basisWeight).toBe('7.500');
    expect(r.metalAmount).toBe('7500.00');
    expect(r.labourAmount).toBe('750.00');
    expect(r.total).toBe('8250.00');
  });
});

describe('computeBill', () => {
  it('intra-state 3% GST split, rounding to rupee', () => {
    const r = computeBill({ lineTotals: ['10000.40', '5000.00'], gstPercent: 3 });
    expect(r.sub).toBe('15000.40');
    expect(r.cgst).toBe('225.01');
    expect(r.sgst).toBe('225.01');
    expect(r.total).toBe('15450.42');
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
