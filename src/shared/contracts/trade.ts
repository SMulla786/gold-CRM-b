/**
 * Phase 10 — old-metal exchange + kacha processing, bullion buy-sell, bhav (rate) booking
 * (spec: docs/modules/07 §7.2–7.4; routes: docs/api-phase10.md).
 * Rates are in settings units (gold /10 g, silver /1 kg) like sell bills. Old metal is a ledger balance
 * (asset GOLD/SILVER, metalForm KACHA → BULLION), never StockItem rows. Party balances: + = party owes the shop.
 */
import { z } from 'zod';
import { id, pageQuery } from './common';
import { decimalInput, METALS, PARTY_TYPES } from './masters';
import type { PartyRefDto } from './masters';
import { inlineUdharInput } from './udhari';
import type { ActivityAction } from '../enums';

/** TRD-02: the inline udhar entry a trade posted (a linked, numbered udhar entry; edited / deleted only via the trade) */
export interface TradeUdharDto {
  txnId: number;
  txnNo: number;
  cashOut: string; onlineOut: string; cashIn: string; onlineIn: string;
  goldOut: string; goldIn: string; silverOut: string; silverIn: string;
  bhav: { direction: 'MONEY_TO_METAL' | 'METAL_TO_MONEY'; metal: 'GOLD' | 'SILVER'; amount: string; rate: string; unitGrams: number; weight: string } | null;
  remark: string | null;
}

const weight = z.coerce.number().finite().min(0).max(1_000_000);
const money = { cash: decimalInput.default(0), online: decimalInput.default(0), bankAccountId: id.optional() };
const bankRule = <T extends { online: number; bankAccountId?: number }>(b: T) => b.online === 0 || b.bankAccountId != null;

export const TRADE_SIDES = ['BUY', 'SELL'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];
export const BHAV_STATUSES = ['PENDING', 'PARTIAL', 'DELIVERED', 'CANCELLED'] as const;
export const BHAV_ENTRY_TYPES = ['LEDGER', 'ONLY_ENTRY'] as const;

// ───────────── TASK-97 shared additions (all optional; absent = behaviour unchanged) ─────────────

/** txnDate range (inclusive) for the trade lists */
const range = { from: z.coerce.date().optional(), to: z.coerce.date().optional() };

export const TRADE_PAY_MODES = ['CASH', 'ONLINE'] as const;
/** One split-payment row. ONLINE needs a bank account. */
export const tradePaymentInput = z
  .object({
    mode: z.enum(TRADE_PAY_MODES),
    amount: decimalInput.positive(),
    bankAccountId: id.optional(),
    reference: z.string().trim().max(100).optional(),
  })
  .refine((p) => p.mode === 'CASH' || p.bankAccountId != null, { message: 'Select a bank account', path: ['bankAccountId'] });
/** When present, REPLACES cash / online / bankAccountId (those must then be left 0): totals = sums by mode, one MONEY ledger row per payment. */
const split = { payments: z.array(tradePaymentInput).min(1).max(20).optional() };
const splitRule = (b: { cash: number; online: number; payments?: unknown[] }) => !b.payments || (b.cash === 0 && b.online === 0);
const splitMsg = { message: 'Use either split payments or cash / online, not both', path: ['payments'] };

export interface TradePaymentDto {
  id: number;
  mode: 'CASH' | 'ONLINE' | 'METAL';
  amount: string;
  bankAccount: { id: number; name: string } | null;
  reference: string | null;
}

/** GET /app/{exchange|buy-sell|bhav-booking}/:id/history — the document's ActivityLog rows, oldest first. */
export interface TradeHistoryDto {
  id: string;
  action: ActivityAction;
  summary: string;
  user: string | null;
  createdAt: string;
  /** EDITED rows: { before, after } document snapshots */
  meta: unknown;
}

// ───────────── Exchange ─────────────

export const exchangeLineInput = z.object({
  weight: weight.positive(),
  touch: z.coerce.number().min(0).max(100),
  serialNo: z.string().trim().max(20).optional(),
  /** G5 weighing block (record only; `weight` stays the authoritative net). Linking a sample never changes its custody. */
  grossWeight: weight.optional(),
  lessWeight: weight.optional(),
  meltWeight: weight.optional(),
  sampleWeight: weight.optional(),
  sampleId: id.optional(),
});

/** G5 given metal: what the customer hands over in this exchange (fine = (gross − less) × touch / 100). */
export const exchangeGivenInput = z.object({ gross: weight.positive(), less: weight.default(0), touch: z.coerce.number().min(0).max(100) })
  .refine((g) => g.less < g.gross, { message: 'Less must be below gross', path: ['less'] });

export const exchangeBody = z
  .object({
    /** BUY = customer's old metal comes in (default); SELL = shop's kacha goes out */
    side: z.enum(TRADE_SIDES).default('BUY'),
    partyId: id,
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    lines: z.array(exchangeLineInput).min(1).max(50),
    /** legacy signed ± fine adjustment; read only when no diff % / g field is sent (then it counts as grams) */
    diffFine: z.coerce.number().finite().default(0),
    /** G5 difference: % of the exchange.defaults base (WEIGHT | FINE) plus grams, each side; the server computes diffFine = plus − minus */
    diffPctPlus: z.coerce.number().min(0).max(100).optional(),
    diffGmPlus: weight.optional(),
    diffPctMinus: z.coerce.number().min(0).max(100).optional(),
    diffGmMinus: weight.optional(),
    given: exchangeGivenInput.optional(),
    /** TRD-02: udhar jama / udhar + bhav cut posted with this exchange (same fields as New Udhar) */
    udhar: inlineUdharInput.optional(),
    /** settings units; 0 → settled as a metal credit/debit on the party (no money) */
    rate: decimalInput.default(0),
    charges: decimalInput.default(0),
    discount: decimalInput.default(0),
    remark: z.string().trim().max(300).optional(),
    ...money,
    ...split,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] })
  .refine((b) => b.rate > 0 || (b.cash === 0 && b.online === 0 && b.charges === 0 && b.discount === 0), {
    message: 'Enter the rate to settle in money',
    path: ['rate'],
  })
  .refine(splitRule, splitMsg)
  .refine((b) => b.rate > 0 || !b.payments, { message: 'Enter the rate to settle in money', path: ['rate'] });

export const exchangeListQuery = pageQuery.extend({
  side: z.enum(TRADE_SIDES).optional(),
  metal: z.enum(METALS).optional(),
  partyId: id.optional(),
  ...range,
  partyType: z.enum(PARTY_TYPES).optional(),
  /** 'true' = has an active (non-reverted) kacha process; 'false' = none */
  processed: z.enum(['true', 'false']).optional(),
});

export interface ExchangeLineDto {
  id: number;
  weight: string;
  touch: string;
  fine: string;
  serialNo: string | null;
  /** G5 weighing block (null = not entered) */
  grossWeight?: string | null;
  lessWeight?: string | null;
  meltWeight?: string | null;
  sampleWeight?: string | null;
  sampleId?: number | null;
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
  /** G5: Σ line fine, never rounded (null = saved before G5) */
  exactFine?: string | null;
  diffFine: string;
  /** G5 difference inputs and the base each side used (exchange.defaults snapshot) */
  diff?: { pctPlus: string; gmPlus: string; pctMinus: string; gmMinus: string; plusBy: 'WEIGHT' | 'FINE' | null; minusBy: 'WEIGHT' | 'FINE' | null };
  /** G5 given metal (null = none) */
  given?: { gross: string; net: string; touch: string; fine: string } | null;
  /** TRD-02 inline udhar (null = none) */
  udhar?: TradeUdharDto | null;
  afterFine: string;
  rate: string;
  charges: string;
  discount: string;
  /** G5: money round-off included in finalAmount (exchange.defaults) */
  roundOff?: string;
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
  /** split-payment rows (empty when paid via cash / online) */
  payments?: TradePaymentDto[];
}

// ───────────── Kacha processing (the branch's kacha pool) ─────────────

export const kachaProcessBody = z
  .object({
    /** G5 PROCESS = 'send to process' batch: reserves the full fine of its exchanges, no ledger; a REFINE with parentId consumes it */
    type: z.enum(['MELT', 'REFINE', 'PROCESS']),
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    /** kacha fine consumed (PROCESS: omitted — the server reserves its exchanges' fine) */
    inFine: weight.optional(),
    /** bullion produced (melt weight / refined bread); 0 on PROCESS */
    outFine: weight.default(0),
    /** REFINE only: residue that stays kacha */
    ravalFine: weight.default(0),
    exchangeId: id.optional(),
    /** PROCESS only: the exchanges batched together */
    exchangeIds: z.array(id).min(1).max(100).optional(),
    /** REFINE only: the PROCESS batch it refines */
    parentId: id.optional(),
    /** REFINE only: DIFFERENCE SELF, signed (+ gain / − loss the shop books itself); record only, no ledger */
    selfDiff: z.coerce.number().finite().min(-1_000_000).max(1_000_000).default(0),
    remark: z.string().trim().max(200).optional(),
  })
  .refine((b) => b.type === 'REFINE' || b.ravalFine === 0, { message: 'Raval applies to refining only', path: ['ravalFine'] })
  .refine((b) => b.type === 'PROCESS' || (b.inFine ?? 0) > 0, { message: 'Enter the kacha fine', path: ['inFine'] })
  .refine((b) => b.type !== 'PROCESS' || (b.exchangeIds?.length && b.inFine === undefined && b.outFine === 0 && b.exchangeId === undefined && b.parentId === undefined), {
    message: 'A process batch takes exchanges only (no fine, bullion, single exchange or parent)', path: ['exchangeIds'] })
  .refine((b) => b.type === 'PROCESS' || b.exchangeIds === undefined, { message: 'Only a process batch lists exchanges', path: ['exchangeIds'] })
  .refine((b) => b.parentId === undefined || (b.type === 'REFINE' && b.exchangeId === undefined), { message: 'Only a refine (without an exchange) can belong to a process batch', path: ['parentId'] })
  .refine((b) => b.type === 'REFINE' || b.selfDiff === 0, { message: 'Self difference applies to refining only', path: ['selfDiff'] });

export const kachaListQuery = pageQuery.extend({
  metal: z.enum(METALS).optional(),
  type: z.enum(['MELT', 'REFINE', 'PROCESS']).optional(),
  /** G5 grouped view: the refines of one process batch */
  parentId: z.coerce.number().int().positive().optional(),
});
/** G5 summary cards (non-reverted processes, by type) */
export const kachaSummaryQuery = z.object({ metal: z.enum(METALS).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
/** metal omitted = All: top-level fields are GOLD (back-compat) and byMetal carries both metals separately */
export const kachaBalanceQuery = z.object({ metal: z.enum(METALS).optional() });

export interface KachaProcessDto {
  id: number;
  type: 'MELT' | 'REFINE' | 'PROCESS';
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
  /** G5: REFINE self difference (record only) */
  selfDiff?: string;
  /** G5: the PROCESS batch a REFINE belongs to */
  parentId?: number | null;
  /** G5 PROCESS: its exchanges, their gross kacha weight, and the fine still reserved (not yet refined) */
  exchanges?: Array<{ id: number; exchangeNo: number }>;
  kachaWeight?: string | null;
  reservedFine?: string;
  /** G5 PROCESS detail: its refines */
  children?: KachaProcessDto[];
}

export interface KachaSummaryDto {
  metal: 'GOLD' | 'SILVER' | null;
  byType: Array<{ type: 'MELT' | 'REFINE' | 'PROCESS'; count: number; inFine: string; outFine: string; ravalFine: string; difference: string; selfDiff: string }>;
  /** kacha fine reserved by open PROCESS batches right now */
  reservedFine: string;
}

/** GET /app/kacha/balance — the KACHA / BULLION cards */
export interface KachaBalanceDto {
  metal: 'GOLD' | 'SILVER';
  /** ledger kacha fine (reserved fine included) */
  kachaFine: string;
  bullionFine: string;
  /** G5: kacha reserved by open PROCESS batches (not available to melts, sells or bills) */
  reservedFine?: string;
  /** only when the query had no metal (All) */
  byMetal?: Array<{ metal: 'GOLD' | 'SILVER'; kachaFine: string; bullionFine: string }>;
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
    /** deliver against this booking: same party/metal/side, every line at the booking rate (= deliveries [{ bookingId, weight: total }]) */
    bhavBookingId: id.optional(),
    /** TRD-03: deliver against several bookings (same party / metal / side / branch). Per rate, the lines' weight must equal
     *  the weight taken from bookings at that rate, and the deliveries cover the whole trade weight. */
    deliveries: z.array(z.object({ bookingId: id, weight: weight.positive() })).min(1).max(20).optional(),
    /** TRD-02: udhar jama / udhar + bhav cut posted with this trade (same fields as New Udhar) */
    udhar: inlineUdharInput.optional(),
    narration: z.string().trim().max(300).optional(),
    ...money,
    ...split,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] })
  .refine(splitRule, splitMsg)
  .refine((b) => b.bhavBookingId == null || b.deliveries == null, { message: 'Send either bhavBookingId or deliveries', path: ['deliveries'] })
  .refine((b) => !b.deliveries || new Set(b.deliveries.map((d) => d.bookingId)).size === b.deliveries.length, { message: 'A booking is listed twice', path: ['deliveries'] });

export const buySellListQuery = pageQuery.extend({ side: z.enum(TRADE_SIDES).optional(), metal: z.enum(METALS).optional(), partyId: id.optional(), ...range });

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
  /** TRD-03: every booking this trade delivered against (a pre-TRD-03 single link shows as one row) */
  deliveries?: Array<{ bookingId: number; bookingNo: number; rate: string; weight: string }>;
  /** TRD-02 inline udhar (null = none) */
  udhar?: TradeUdharDto | null;
  narration: string | null;
  lines: Array<{ id: number; weight: string; rate: string; amount: string }>;
  createdBy: string | null;
  createdAt: string;
  payments?: TradePaymentDto[];
}

// ───────────── Bhav booking ─────────────

export const bhavBookingBody = z
  .object({
    side: z.enum(TRADE_SIDES),
    partyId: id,
    metal: z.enum(METALS),
    txnDate: z.coerce.date().optional(),
    /** required unless lines[] is given */
    weight: weight.positive().optional(),
    /** required unless lines[] is given */
    rate: decimalInput.positive().optional(),
    /**
     * Multi-row booking. When present: weight = sum of row weights, amount = sum of metalToMoney(weight, rate) per row,
     * rate = sum(weight x rate) / sum(weight) rounded to 2 dp (the locked delivery rate); weight / rate above are ignored.
     */
    lines: z.array(buySellLineInput).min(1).max(50).optional(),
    /** ONLY_ENTRY = record only: the advance is NOT posted to the ledger / party udhar */
    entryType: z.enum(BHAV_ENTRY_TYPES).default('LEDGER'),
    narration: z.string().trim().max(300).optional(),
    /** advance */
    ...money,
    ...split,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] })
  .refine((b) => !!b.lines || (b.weight != null && b.rate != null), { message: 'Enter the weight and rate', path: ['weight'] })
  .refine(splitRule, splitMsg);

export const bhavListQuery = pageQuery.extend({
  side: z.enum(TRADE_SIDES).optional(),
  status: z.enum(BHAV_STATUSES).optional(),
  /** PENDING + PARTIAL only (the buy-sell picker) */
  open: z.enum(['true', 'false']).optional(),
  partyId: id.optional(),
  metal: z.enum(METALS).optional(),
  ...range,
  /** DELIVERED + CANCELLED only (Old bookings) */
  closed: z.enum(['true', 'false']).optional(),
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
  /** advance split (advance = cash + online) */
  cash?: string;
  online?: string;
  entryType?: (typeof BHAV_ENTRY_TYPES)[number];
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  /** multi-row bookings only (empty for a single weight / rate booking) */
  lines?: Array<{ id: number; weight: string; rate: string; amount: string }>;
  payments?: TradePaymentDto[];
}
