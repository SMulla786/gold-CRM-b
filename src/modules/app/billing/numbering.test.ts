import { describe, expect, it } from 'vitest';
import { SETTING_SCHEMAS } from '../../../shared';
import { docKey, formatBillNo, fyStartYear, seriesStart } from './numbering';

const n = (over: Record<string, unknown>) => SETTING_SCHEMAS['invoice.sale'].parse(over);
const JUN = new Date('2026-06-01T00:00:00Z'); // FY 2026-27
const MAR = new Date('2026-03-31T00:00:00Z'); // FY 2025-26
const APR = new Date('2026-04-01T00:00:00Z'); // FY 2026-27

describe('bill numbering', () => {
  it('NUMERIC → zero-padded sequence only', () => {
    expect(formatBillNo(1, 'GST', n({ format: 'NUMERIC', padding: 5 }), JUN)).toBe('00001');
    expect(formatBillNo(42, 'GST', n({ format: 'NUMERIC', padding: 6 }), JUN)).toBe('000042');
  });

  it('PREFIX → prefix + padded number (GST vs ROUGH use their own prefix)', () => {
    const settings = n({ format: 'PREFIX', gstPrefix: 'INV', roughPrefix: 'EST', delimiter: '/' });
    expect(formatBillNo(7, 'GST', settings, JUN)).toBe('INV/00007');
    expect(formatBillNo(7, 'ROUGH', settings, JUN)).toBe('EST/00007');
  });

  it('FY_PREFIX → prefix + financial year + number, in each fy label format', () => {
    expect(formatBillNo(1, 'GST', n({ format: 'FY_PREFIX', gstPrefix: 'INV', fyFormat: 'FULL' }), JUN)).toBe('INV/2026-27/00001');
    expect(formatBillNo(1, 'GST', n({ format: 'FY_PREFIX', gstPrefix: 'INV', fyFormat: 'SHORT' }), JUN)).toBe('INV/26-27/00001');
    expect(formatBillNo(1, 'GST', n({ format: 'FY_PREFIX', gstPrefix: 'INV', fyFormat: 'YEAR' }), JUN)).toBe('INV/2026/00001');
  });

  it('FY boundary: 31 Mar and 1 Apr fall in different financial years → different counter keys', () => {
    expect(fyStartYear(MAR)).toBe(2025);
    expect(fyStartYear(APR)).toBe(2026);
    const settings = n({ format: 'FY_PREFIX', gstPrefix: 'INV' });
    expect(docKey('SELL', 'GST', settings, MAR)).toBe('SELL:GST:2025');
    expect(docKey('SELL', 'GST', settings, APR)).toBe('SELL:GST:2026');
    // a non-FY series shares one key regardless of date
    expect(docKey('SELL', 'GST', n({ format: 'PREFIX' }), MAR)).toBe('SELL:GST');
  });

  it('seriesStart picks the GST/ROUGH start', () => {
    const settings = n({ gstStart: 101, roughStart: 5 });
    expect(seriesStart('GST', settings)).toBe(101);
    expect(seriesStart('ROUGH', settings)).toBe(5);
  });
});
