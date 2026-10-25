/**
 * Pilot — opening balances (routes: docs/api-pilot.md). A shop moving onto the app enters what it already holds
 * (cash, bank, bullion fine metal) and what each party already owes. Stock opening = New Stock / CSV import (exists).
 * No table: every save posts LedgerEntry / UdharEntry rows with source OPENING_BALANCE and one shared sourceId.
 */
import { z } from 'zod';
import { id } from './common';
import { decimalInput, METALS } from './masters';

const signed = z.coerce.number().finite();

export const openingEntryInput = z.discriminatedUnion('kind', [
  /** shop cash in hand */
  z.object({ kind: z.literal('CASH'), amount: decimalInput.positive() }),
  z.object({ kind: z.literal('BANK'), bankAccountId: id, amount: decimalInput.positive() }),
  /** fine bullion / kacha metal the shop holds outside tagged stock */
  z.object({ kind: z.literal('METAL'), metal: z.enum(METALS), metalForm: z.enum(['BULLION', 'KACHA']), fine: decimalInput.positive() }),
  /** party udhar carried over: + = party owes the shop, − = shop owes the party (same sign convention as udhari) */
  z
    .object({ kind: z.literal('PARTY'), partyId: id, amount: signed.default(0), gold: signed.default(0), silver: signed.default(0) })
    .refine((p) => p.amount !== 0 || p.gold !== 0 || p.silver !== 0, { message: 'Enter an amount, gold or silver' }),
]);
export type OpeningEntryInput = z.infer<typeof openingEntryInput>;

export const openingBalanceBody = z.object({
  /** business date the balances are "as of"; default today */
  txnDate: z.coerce.date().optional(),
  entries: z.array(openingEntryInput).min(1).max(500),
  remark: z.string().trim().max(200).optional(),
});

export interface OpeningBatchDto {
  /** shared sourceId of every row in this save — DELETE /app/opening-balances/:sourceId reverses it */
  sourceId: string;
  txnDate: string;
  branch: { id: number; name: string };
  remark: string | null;
  cash: string;
  bank: Array<{ bankAccount: { id: number; name: string }; amount: string }>;
  metal: Array<{ metal: 'GOLD' | 'SILVER'; metalForm: 'BULLION' | 'KACHA'; fine: string }>;
  parties: Array<{ party: { id: number; name: string }; amount: string; gold: string; silver: string }>;
  reversed: boolean;
  createdBy: string | null;
  createdAt: string;
}
