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

/** TASK-81: surface manual (DIRECT) income/expense rows alongside auto-entries from other modules. */
export const IE_SOURCE_TYPES = ['DIRECT', 'SELL_BILL', 'PURCHASE_BILL', 'GIRVI', 'UDHAR'] as const;

export const incomeExpenseListQuery = pageQuery.extend({
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  sourceType: z.enum(IE_SOURCE_TYPES).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});

/** TASK-81: per-day roll-up for the "Old list" summary view. Decimals as strings. */
export interface IncomeExpenseDailySummaryDto {
  date: string;
  cashIn: string;
  cashOut: string;
  /** (cash + online) IN − OUT for the day */
  profit: string;
  /** fine grams IN − OUT */
  goldNet: string;
  silverNet: string;
  /** TASK-97: fine grams in / out separately (net = in − out) */
  goldIn?: string;
  goldOut?: string;
  silverIn?: string;
  silverOut?: string;
}

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
  /** TASK-97: DIRECT = manual row (editable); others are auto rows from that module (read-only) */
  sourceType?: (typeof IE_SOURCE_TYPES)[number];
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
  /** one stock item's movement history (insert, edits, transfers, sale later) */
  stockItemId: id.optional(),
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
  /** stock item touched by this row (item name + tag), for the Item column; TASK-98: + item group / name for the Type column */
  item: { id: number; label: string; group?: string; name?: string } | null;
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
  /** TASK-97: 'DATE' also returns `days` — one opening/in/out/closing row per business day in the range (max 62 days) */
  groupBy: z.enum(['DATE']).optional(),
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
  /** TASK-80: the branch-day status when a single day is requested (from === to); null for a range. */
  status?: 'OPEN' | 'CLOSED' | null;
  totals: AssetTotalsDto[];
  bySource: Array<{ source: (typeof LEDGER_SOURCES)[number]; asset: (typeof LEDGER_ASSETS)[number]; in: string; out: string }>;
  /** TASK-97: present when groupBy=DATE — newest day first */
  days?: DayBookDayDto[];
}

export interface DayBookDayDto {
  date: string;
  /** branch-day status for the active branch; null when viewing all branches */
  status: 'OPEN' | 'CLOSED' | null;
  totals: Array<Omit<AssetTotalsDto, 'value'>>;
}

/** TASK-90: Day-Book "All-in-One" — one row per source document with every asset's IN/OUT side by side. */
export const dayBookAllInOneQuery = pageQuery.extend({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  source: z.enum(LEDGER_SOURCES).optional(),
});
export interface DayBookAllInOneRowDto {
  txnDate: string;
  source: (typeof LEDGER_SOURCES)[number];
  sourceId: string;
  party: { id: number; name: string } | null;
  narration: string | null;
  /** per asset, main unit as in LedgerRowDto.balance; assets with no movement are "0" */
  assets: Record<(typeof LEDGER_ASSETS)[number], { in: string; out: string }>;
  /** TASK-98: earliest createdAt (ISO) of the document's ledger rows — the row's time */
  createdAt?: string;
  /** TASK-98: MONEY in/out split by holder — cash = shop cash (no bank account), bank = any bank account */
  money?: { cashIn: string; cashOut: string; bankIn: string; bankOut: string };
  /** TASK-98: distinct metal forms (USUAL/BULLION/KACHA) and karat codes moved per metal; empty arrays when none */
  metal?: Record<'GOLD' | 'SILVER', { forms: string[]; karats: string[] }>;
  /** TASK-98: running balance AFTER this document (MONEY amount, GOLD/SILVER fine), chronological: opening before `from`
   *  (Day-Book rule, same source filter) + every document up to this one. Rows are listed newest first. */
  balance?: Record<'MONEY' | 'GOLD' | 'SILVER', string>;
  /** G2b C2: the parent bill of a bill row ('<billId>') and of each of its payment rows ('<billId>-P<n>'); null for other sources.
   *  Payments stay separate rows — the bill's own row carries only its stock movement, so MONEY is never counted twice. */
  billId?: number | null;
}

/**
 * Old Metal Ledger: old/raw (KACHA) gold & silver flowing through every module (bills' old-gold payments, exchange,
 * kacha processing, opening…). Summary = per source module; the row history is GET /app/ledgers?asset=GOLD|SILVER&metalForm=KACHA.
 */
export const oldMetalSummaryQuery = z.object({ from: dateOnly.optional(), to: dateOnly.optional() });
export interface OldMetalSummaryRowDto {
  source: (typeof LEDGER_SOURCES)[number];
  /** fine grams */
  goldIn: string;
  goldOut: string;
  goldNet: string;
  silverIn: string;
  silverOut: string;
  silverNet: string;
}
