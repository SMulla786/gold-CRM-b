import type { BillKind, BillType, SettingValue } from '../../../shared';

/** invoice.sale and invoice.purchase share the same `numbering` schema. */
export type Numbering = SettingValue<'invoice.sale'>;

/** Indian financial year is Apr–Mar; the start year of the FY containing `date` (UTC, since bill dates are @db.Date). */
export function fyStartYear(date: Date): number {
  return date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1; // month 3 = April
}

function fyLabel(date: Date, fyFormat: Numbering['fyFormat']): string {
  const s = fyStartYear(date);
  const e2 = String(s + 1).slice(-2);
  if (fyFormat === 'YEAR') return String(s);
  if (fyFormat === 'SHORT') return `${String(s).slice(-2)}-${e2}`;
  return `${s}-${e2}`; // FULL, e.g. 2026-27
}

/** DocSequence key — one counter per kind+type (and per FY only when the series resets each year). */
export function docKey(kind: BillKind, billType: BillType, n: Numbering, date: Date): string {
  const base = `${kind}:${billType}`;
  return n.format === 'FY_PREFIX' ? `${base}:${fyStartYear(date)}` : base;
}

/** First number of a series (GST vs ROUGH start, per invoice settings). */
export const seriesStart = (billType: BillType, n: Numbering): number => (billType === 'GST' ? n.gstStart : n.roughStart);

/** Format a sequence into the display bill number per the invoice numbering settings. */
export function formatBillNo(seq: number, billType: BillType, n: Numbering, date: Date): string {
  const num = String(seq).padStart(n.padding, '0');
  if (n.format === 'NUMERIC') return num;
  const prefix = billType === 'GST' ? n.gstPrefix : n.roughPrefix;
  const parts = [prefix];
  if (n.format === 'FY_PREFIX') parts.push(fyLabel(date, n.fyFormat));
  parts.push(num);
  return parts.filter((p) => p !== '').join(n.delimiter);
}
