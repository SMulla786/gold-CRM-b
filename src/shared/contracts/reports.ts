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
