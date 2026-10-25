/**
 * Phase 10 — old-metal exchange + kacha processing, bullion buy-sell, bhav (rate) booking
 * (spec: docs/modules/07 §7.2–7.4; routes: docs/api-phase10.md).
 * Rates are in settings units (gold /10 g, silver /1 kg) like sell bills. Old metal is a ledger balance
 * (asset GOLD/SILVER, metalForm KACHA → BULLION), never StockItem rows. Party balances: + = party owes the shop.
 */
import { z } from 'zod';
import { id, pageQuery } from './common';
import { decimalInput, METALS } from './masters';
import type { PartyRefDto } from './masters';

const weight = z.coerce.number().finite().min(0).max(1_000_000);
const money = { cash: decimalInput.default(0), online: decimalInput.default(0), bankAccountId: id.optional() };
const bankRule = <T extends { online: number; bankAccountId?: number }>(b: T) => b.online === 0 || b.bankAccountId != null;

export const TRADE_SIDES = ['BUY', 'SELL'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];
export const BHAV_STATUSES = ['PENDING', 'PARTIAL', 'DELIVERED', 'CANCELLED'] as const;

// ───────────── Exchange ─────────────

export const exchangeLineInput = z.object({
  weight: weight.positive(),
  touch: z.coerce.number().min(0).max(100),
  serialNo: z.string().trim().max(20).optional(),
});

export const exchangeBody = z
  .object({
    /** BUY = customer's old metal comes in (default); SELL = shop's kacha goes out */
    side: z.enum(TRADE_SIDES).default('BUY'),
    partyId: id,
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    lines: z.array(exchangeLineInput).min(1).max(50),
    /** signed ± fine adjustment */
    diffFine: z.coerce.number().finite().default(0),
    /** settings units; 0 → settled as a metal credit/debit on the party (no money) */
    rate: decimalInput.default(0),
    charges: decimalInput.default(0),
    discount: decimalInput.default(0),
    remark: z.string().trim().max(300).optional(),
    ...money,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] })
  .refine((b) => b.rate > 0 || (b.cash === 0 && b.online === 0 && b.charges === 0 && b.discount === 0), {
    message: 'Enter the rate to settle in money',
    path: ['rate'],
  });

export const exchangeListQuery = pageQuery.extend({ side: z.enum(TRADE_SIDES).optional(), metal: z.enum(METALS).optional(), partyId: id.optional() });

export interface ExchangeLineDto {
  id: number;
  weight: string;
  touch: string;
  fine: string;
  serialNo: string | null;
}

export interface ExchangeDto {
  id: number;
  exchangeNo: number;
  side: TradeSide;
  party: PartyRefDto;
  branch: { id: number; name: string };
  metal: 'GOLD' | 'SILVER';
  txnDate: string;
  totalFine: string;
  diffFine: string;
  afterFine: string;
  rate: string;
  charges: string;
  discount: string;
  finalAmount: string;
  cash: string;
  online: string;
  bankAccount: { id: number; name: string } | null;
  /** finalAmount − cash − online, signed for the party (+ = party owes) */
  balance: string;
  remark: string | null;
  lines: ExchangeLineDto[];
  /** any non-reverted kacha process linked to it */
  processed: boolean;
  createdBy: string | null;
  createdAt: string;
}

// ───────────── Kacha processing (the branch's kacha pool) ─────────────

export const kachaProcessBody = z
  .object({
    type: z.enum(['MELT', 'REFINE']),
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    /** kacha fine consumed */
    inFine: weight.positive(),
    /** bullion produced (melt weight / refined bread) */
    outFine: weight,
    /** REFINE only: residue that stays kacha */
    ravalFine: weight.default(0),
    exchangeId: id.optional(),
    remark: z.string().trim().max(200).optional(),
  })
  .refine((b) => b.type === 'REFINE' || b.ravalFine === 0, { message: 'Raval applies to refining only', path: ['ravalFine'] });

export const kachaListQuery = pageQuery.extend({ metal: z.enum(METALS).optional() });
export const kachaBalanceQuery = z.object({ metal: z.enum(METALS) });

export interface KachaProcessDto {
  id: number;
  type: 'MELT' | 'REFINE';
  metal: 'GOLD' | 'SILVER';
  txnDate: string;
  inFine: string;
  outFine: string;
  ravalFine: string;
  difference: string;
  exchange: { id: number; exchangeNo: number } | null;
  remark: string | null;
  reverted: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** GET /app/kacha/balance — the KACHA / BULLION cards */
export interface KachaBalanceDto {
  metal: 'GOLD' | 'SILVER';
  kachaFine: string;
  bullionFine: string;
}

// ───────────── Buy-sell (bullion) ─────────────

export const buySellLineInput = z.object({ weight: weight.positive(), rate: decimalInput.positive() });

export const buySellBody = z
  .object({
    side: z.enum(TRADE_SIDES),
    partyId: id,
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    lines: z.array(buySellLineInput).min(1).max(50),
    discount: decimalInput.default(0),
    /** deliver against this booking: same party/metal/side, every line at the booking rate */
    bhavBookingId: id.optional(),
    narration: z.string().trim().max(300).optional(),
    ...money,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] });

export const buySellListQuery = pageQuery.extend({ side: z.enum(TRADE_SIDES).optional(), metal: z.enum(METALS).optional(), partyId: id.optional() });

export interface BuySellDto {
  id: number;
  buySellNo: number;
  side: TradeSide;
  party: PartyRefDto;
  branch: { id: number; name: string };
  metal: 'GOLD' | 'SILVER';
  txnDate: string;
  totalWeight: string;
  discount: string;
  totalAmount: string;
  cash: string;
  online: string;
  bankAccount: { id: number; name: string } | null;
  balance: string;
  bhavBooking: { id: number; bookingNo: number } | null;
  narration: string | null;
  lines: Array<{ id: number; weight: string; rate: string; amount: string }>;
  createdBy: string | null;
  createdAt: string;
}

// ───────────── Bhav booking ─────────────

export const bhavBookingBody = z
  .object({
    side: z.enum(TRADE_SIDES),
    partyId: id,
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    weight: weight.positive(),
    rate: decimalInput.positive(),
    narration: z.string().trim().max(300).optional(),
    /** advance */
    ...money,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] });

export const bhavListQuery = pageQuery.extend({
  side: z.enum(TRADE_SIDES).optional(),
  status: z.enum(BHAV_STATUSES).optional(),
  /** PENDING + PARTIAL only (the buy-sell picker) */
  open: z.enum(['true', 'false']).optional(),
  partyId: id.optional(),
  metal: z.enum(METALS).optional(),
});

export interface BhavBookingDto {
  id: number;
  bookingNo: number;
  side: TradeSide;
  party: PartyRefDto;
  branch: { id: number; name: string };
  metal: 'GOLD' | 'SILVER';
  txnDate: string;
  weight: string;
  rate: string;
  amount: string;
  advance: string;
  bankAccount: { id: number; name: string } | null;
  pendingWeight: string;
  status: (typeof BHAV_STATUSES)[number];
  narration: string | null;
  createdBy: string | null;
  createdAt: string;
}
