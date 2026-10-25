/**
 * Phase 3 — accounts contracts: income/expense, asset ledgers, Day-Book (spec: docs/modules/09-accounts-ledgers.md,
 * routes: docs/api-phase3.md). Everything except IncomeExpense headers is read from LedgerEntry.
 */
import { z } from 'zod';
import { LEDGER_ASSETS, LEDGER_SOURCES } from '../enums';
import { id, pageQuery } from './common';
import { decimalInput } from './masters';

const dateOnly = z.coerce.date();

export const incomeExpenseBody = z
  .object({
    type: z.enum(['INCOME', 'EXPENSE']),
    reason: z.string().trim().min(2).max(200),
    cash: decimalInput.default(0),
    online: decimalInput.default(0),
    /** required when online > 0 */
    bankAccountId: id.optional(),
    gold: decimalInput.default(0),
    silver: decimalInput.default(0),
    remark: z.string().trim().max(300).optional(),
    txnDate: dateOnly.optional(),
  })
  .refine((b) => b.cash + b.online + b.gold + b.silver > 0, { message: 'Enter an amount or metal weight' })
  .refine((b) => b.online === 0 || b.bankAccountId != null, { message: 'Select a bank account for online amount', path: ['bankAccountId'] });

export const incomeExpenseListQuery = pageQuery.extend({
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

export interface IncomeExpenseDto {
  id: number;
  txnDate: string;
  type: 'INCOME' | 'EXPENSE';
  reason: string;
  cash: string;
  online: string;
  bankAccount: { id: number; name: string } | null;
  gold: string;
  silver: string;
  remark: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** One asset ledger page (Money / Gold / Silver / Stone / Artificial / Franchise TXN). */
export const ledgerQuery = pageQuery.extend({
  asset: z.enum(LEDGER_ASSETS),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  source: z.enum(LEDGER_SOURCES).optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  /** MONEY only: 0 = shop cash, else bank account id */
  bankAccountId: z.coerce.number().int().min(0).optional(),
  metalForm: z.enum(['USUAL', 'BULLION', 'KACHA']).optional(),
  partyId: id.optional(),
});

export interface LedgerRowDto {
  id: string;
  txnDate: string;
  createdAt: string;
  branch: { id: number; name: string };
  source: (typeof LEDGER_SOURCES)[number];
  sourceId: string;
  direction: 'IN' | 'OUT';
  party: { id: number; name: string } | null;
  bankAccount: { id: number; name: string } | null;
  metalForm: 'USUAL' | 'BULLION' | 'KACHA' | null;
  karatCode: string | null;
  pcs: number | null;
  gross: string | null;
  net: string | null;
  fine: string | null;
  amount: string | null;
  /** stock item touched by this row (item name + tag), for the Item column */
  item: { id: number; label: string } | null;
  narration: string | null;
  isReversal: boolean;
  /** true when a later row reverses this one — show struck-through */
  reversed: boolean;
  /** running balance after this row, in the asset's main unit (MONEY: amount, metals: fine, stone/artificial/franchise: pcs) */
  balance: string;
  entryBy: string | null;
}

export interface LedgerPageDto {
  /** balance before the first row of the requested range (independent of page) */
  opening: string;
  items: LedgerRowDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Day-Book: per-asset opening / in / out / closing for a date range, plus per-source breakdown. */
export const dayBookQuery = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  source: z.enum(LEDGER_SOURCES).optional(),
});

export interface AssetTotalsDto {
  asset: (typeof LEDGER_ASSETS)[number];
  /** main unit as in LedgerRowDto.balance */
  opening: string;
  in: string;
  out: string;
  closing: string;
  /** Σ amount IN − OUT up to `to` (rupee value; for stone/artificial/franchise the Total Cost) */
  value: string;
}

export interface DayBookDto {
  from: string;
  to: string;
  totals: AssetTotalsDto[];
  bySource: Array<{ source: (typeof LEDGER_SOURCES)[number]; asset: (typeof LEDGER_ASSETS)[number]; in: string; out: string }>;
}
