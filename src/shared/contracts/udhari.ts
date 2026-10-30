/**
 * Phase 5 — udhari contracts: party accounts in ₹ / gold g / silver g (spec: docs/modules/05-udhari.md, routes: docs/api-phase5.md).
 * Sign convention everywhere: + = party owes the shop, − = shop owes the party.
 */
import { z } from 'zod';
import { LEDGER_SOURCES } from '../enums';
import { id, pageQuery } from './common';
import { decimalInput, METALS, PARTY_TYPES } from './masters';
import type { PartyRefDto } from './masters';

const weight = z.coerce.number().finite().min(0).max(1_000_000);

/** The money / metal / bhav-cut movement of an udhar entry (shared by New Udhar and the inline udhar of a trade). */
const udharMovement = {
    /** given to the party (party owes more) */
    cashOut: decimalInput.default(0),
    onlineOut: decimalInput.default(0),
    outBankId: id.optional(),
    /** received from the party (party owes less) */
    cashIn: decimalInput.default(0),
    onlineIn: decimalInput.default(0),
    inBankId: id.optional(),
    goldOut: weight.default(0),
    goldIn: weight.default(0),
    silverOut: weight.default(0),
    silverIn: weight.default(0),
    /** bhav cut: move `bhavAmount` ₹ ⇄ metal at bhavRate per bhavUnitGrams (MONEY_TO_METAL: amount −X, metal +W; METAL_TO_MONEY: metal −W, amount +X) */
    bhav: z
      .object({
        direction: z.enum(['MONEY_TO_METAL', 'METAL_TO_MONEY']),
        metal: z.enum(METALS),
        amount: decimalInput.positive(),
        rate: decimalInput.positive(),
        unitGrams: z.union([z.literal(1), z.literal(10), z.literal(1000)]),
      })
      .optional(),
    remark: z.string().trim().max(300).optional(),
};
type Movement = { onlineOut: number; outBankId?: number; onlineIn: number; inBankId?: number; cashOut: number; cashIn: number; goldOut: number; goldIn: number; silverOut: number; silverIn: number; bhav?: unknown };
const outBank = (b: Movement) => b.onlineOut === 0 || b.outBankId != null;
const inBank = (b: Movement) => b.onlineIn === 0 || b.inBankId != null;
const nonEmpty = (b: Movement) => b.cashOut + b.onlineOut + b.cashIn + b.onlineIn + b.goldOut + b.goldIn + b.silverOut + b.silverIn > 0 || b.bhav != null;
const BANK = { message: 'Select a bank account' };
const EMPTY = { message: 'Enter an amount, a metal weight or a bhav cut' };

/** TASK-99 inline udhar on a buy-sell / exchange: the same movement as New Udhar, posted as a linked udhar entry of the trade's party and date. */
export const inlineUdharInput = z
  .object(udharMovement)
  .refine(outBank, { ...BANK, path: ['outBankId'] })
  .refine(inBank, { ...BANK, path: ['inBankId'] })
  .refine(nonEmpty, EMPTY);
export type InlineUdharInput = z.infer<typeof inlineUdharInput>;

export const udharBody = z
  .object({
    partyId: id,
    txnDate: z.coerce.date().optional(),
    ...udharMovement,
    /** apply (cashIn + onlineIn) to this pending SELL bill, or (cashOut + onlineOut) to this pending PURCHASE bill, of the same party (adds BillPayments) */
    settleBillId: id.optional(),
  })
  .refine(outBank, { ...BANK, path: ['outBankId'] })
  .refine(inBank, { ...BANK, path: ['inBankId'] })
  .refine(nonEmpty, EMPTY)
  .refine((b) => b.settleBillId == null || b.cashIn + b.onlineIn + b.cashOut + b.onlineOut > 0, { message: 'Enter the amount received or paid to settle the bill', path: ['settleBillId'] });
export type UdharBody = z.infer<typeof udharBody>;

export interface BalanceDto {
  amount: string;
  gold: string;
  silver: string;
}

export interface UdharTxnDto {
  id: number;
  txnNo: number;
  txnDate: string;
  party: PartyRefDto;
  branch: { id: number; name: string };
  cashOut: string;
  onlineOut: string;
  outBank: { id: number; name: string } | null;
  cashIn: string;
  onlineIn: string;
  inBank: { id: number; name: string } | null;
  goldOut: string;
  goldIn: string;
  silverOut: string;
  silverIn: string;
  bhav: { direction: 'MONEY_TO_METAL' | 'METAL_TO_MONEY'; metal: 'GOLD' | 'SILVER'; amount: string; rate: string; unitGrams: number; weight: string } | null;
  settleBill: { id: number; billNo: string } | null;
  /** party balance before / after this transaction (all branches in scope) */
  old: BalanceDto;
  final: BalanceDto;
  remark: string | null;
  isDeleted: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** Udhar List (transaction-wise across sources, from UdharEntry grouped by source+sourceId). */
export const udharEntryListQuery = pageQuery.extend({
  partyId: id.optional(),
  /** TASK-83: any ledger source an UdharEntry can carry (order receive, karigar, scheme, girvi, …) */
  source: z.enum(LEDGER_SOURCES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export interface UdharEntryRowDto {
  source: string;
  sourceId: string;
  /** bill no / udhar txn no for display + link */
  reference: string;
  txnDate: string;
  party: PartyRefDto;
  amount: string;
  gold: string;
  silver: string;
  narration: string | null;
  isReversal: boolean;
  createdAt: string;
  /** Udhar List only: party running balance just before / after this row (same txnDate,id order as the Statement) */
  old?: BalanceDto;
  final?: BalanceDto;
}

/** Udhar Ledger: party-wise balances. */
export const udharLedgerQuery = pageQuery.extend({
  type: z.enum(PARTY_TYPES).optional(),
  /** hide parties whose three balances are all zero */
  nonZero: z.enum(['true', 'false']).default('true'),
  /** TASK-83: period for the Old/In/Out/Final columns */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export interface PartyBalanceRowDto extends BalanceDto {
  party: PartyRefDto;
  lastTxnDate: string | null;
  /** TASK-83 columnar view per unit: old = Σ before `from`, in = Σ positive, out = Σ |negative|
   *  in the period, final = old + in − out. The inherited amount/gold/silver stay the all-time current balance. */
  old?: BalanceDto;
  in?: BalanceDto;
  out?: BalanceDto;
  final?: BalanceDto;
}

/** Party statement: opening + rows in range with running balance per unit. */
export const statementQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
export interface StatementDto {
  party: PartyRefDto;
  opening: BalanceDto;
  rows: Array<UdharEntryRowDto & { balance: BalanceDto }>;
  closing: BalanceDto;
}

/** Pending bills (balance ≠ 0), both kinds. */
export const pendingBillsQuery = pageQuery.extend({ partyId: id.optional(), type: z.enum(PARTY_TYPES).optional() });
