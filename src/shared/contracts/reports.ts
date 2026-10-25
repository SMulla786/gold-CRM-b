/**
 * Phase 6 — dashboard + GST basics (spec: docs/modules/01-shell-dashboard.md, 10-gst-reports.md; routes: docs/api-phase6.md).
 * Admins with X-Branch-Id: all get the subtree consolidated; byBranch splits it.
 */
import { z } from 'zod';
import { ACTIVITY_ACTIONS, STOCK_CLASSES } from '../enums';
import { pageQuery } from './common';
import type { BalanceDto } from './udhari';

const range = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };

export interface DashboardDto {
  date: string;
  parties: { customers: number; suppliers: number; customersNewThisMonth: number };
  stock: Array<{ stockClass: (typeof STOCK_CLASSES)[number]; items: number; pcs: number; net: string; fine: string; value: string }>;
  sales: { todayTotal: string; todayCount: number; todayReceived: string; monthTotal: string; yearTotal: string; pendingBalance: string };
  purchases: { monthTotal: string };
  /** Σ party balances (+ receivable only) */
  udhari: BalanceDto & { collectedThisMonth: string };
  cash: { inHand: string; bank: string };
  activityToday: Record<(typeof ACTIVITY_ACTIONS)[number], number>;
  /** last 12 months, oldest first */
  monthly: Array<{ month: string; sales: string; purchases: string }>;
  /** only with X-Branch-Id: all — per-branch sales today/month */
  byBranch: Array<{ branch: { id: number; name: string }; todayTotal: string; monthTotal: string }> | null;
}

export const activityQuery = pageQuery.extend({
  ...range,
  module: z.string().optional(),
  action: z.enum(ACTIVITY_ACTIONS).optional(),
  userId: z.coerce.number().int().positive().optional(),
});
export interface ActivityDto {
  id: string;
  createdAt: string;
  module: string;
  action: (typeof ACTIVITY_ACTIONS)[number];
  summary: string;
  partyName: string | null;
  entity: string;
  entityId: string;
  user: string | null;
  branch: { id: number; name: string } | null;
}

/** GST reports read ACTIVE GST bills only (ROUGH excluded). */
export const gstRangeQuery = z.object(range);
export const gstRegisterQuery = pageQuery.extend({ ...range, kind: z.enum(['SELL', 'PURCHASE']) });
export interface GstRegisterRowDto {
  billId: number;
  billNo: string;
  billDate: string;
  party: { id: number; name: string; gstin: string | null };
  hsnCodes: string[];
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
}
export interface HsnSummaryRowDto {
  hsnCode: string;
  stockClass: string;
  weight: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
}
export interface GstSummaryRowDto {
  /** YYYY-MM / YYYY-Qn / FY label */
  period: string;
  salesTaxable: string;
  purchaseTaxable: string;
  outputGst: string;
  inputGst: string;
  netPayable: string;
}
export const gstSummaryQuery = z.object({ ...range, groupBy: z.enum(['MONTH', 'QUARTER', 'YEAR']).default('MONTH') });

// ───────────── Phase 12: GSTR-1 / GSTR-3B (docs/api-phase12.md) ─────────────

/** Unregistered inter-state invoices above this go to B2CL. shortcut: constant, make it a setting if the rule changes again. */
export const B2CL_LIMIT = 100000;
/** one return period (UI sends a month) */
export const gstFilingQuery = z.object({ from: z.coerce.date(), to: z.coerce.date() });

interface TaxCols {
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
}
export interface Gstr1InvoiceRow extends TaxCols {
  billId: number;
  invNo: string;
  invDate: string;
  invValue: string;
  /** 2-digit state code */
  pos: string;
  rate: string;
}
export interface Gstr1B2bRow extends Gstr1InvoiceRow {
  gstin: string;
  party: string;
}
export interface Gstr1B2csRow extends TaxCols {
  pos: string;
  rate: string;
  supplyType: 'INTRA' | 'INTER';
}
export interface Gstr1HsnRow extends TaxCols {
  hsnCode: string;
  uqc: 'GMS' | 'PCS';
  qty: string;
  rate: string;
  total: string;
}
/** GST sell bill issued before the period and deleted inside it, registered party */
export interface Gstr1CdnrRow extends Gstr1B2bRow {
  noteDate: string;
}
export interface Gstr1Dto {
  from: string;
  to: string;
  /** shop GSTIN (branch → business); null → UI warns "set your GSTIN to file" */
  gstin: string | null;
  b2b: Gstr1B2bRow[];
  b2cl: Gstr1InvoiceRow[];
  /** aggregated by POS + rate; includes negative rows for unregistered credit notes */
  b2cs: Gstr1B2csRow[];
  hsnB2b: Gstr1HsnRow[];
  hsnB2c: Gstr1HsnRow[];
  cdnr: Gstr1CdnrRow[];
  /** one row per invoice series; cancelled = deleted with billDate in the period */
  docIssue: Array<{ series: string; from: string; to: string; total: number; cancelled: number }>;
  totals: TaxCols & { invoices: number };
}
export interface Gstr3bDto {
  from: string;
  to: string;
  gstin: string | null;
  /** 3.1(a) outward taxable supplies (ACTIVE GST sell bills) */
  outward: TaxCols;
  /** informational: ROUGH sell bills' final */
  nonGst: string;
  /** 4 ITC: ACTIVE GST purchase bills from parties with a GSTIN */
  itc: { cgst: string; sgst: string; igst: string };
  /** Σ output tax − Σ ITC, floored at 0 — the portal does the per-head set-off */
  netPayableIndicative: string;
}
