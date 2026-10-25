/**
 * Phase 4 — billing contracts: sell & purchase bills (spec: docs/modules/02-billing.md, routes: docs/api-phase4.md).
 * The server recomputes every line and the bill with the shared calc engine — client totals are display only.
 */
import { z } from 'zod';
import { STOCK_CLASSES } from '../enums';
import { id, pageQuery } from './common';
import { CHARGE_UNITS } from './inventory';
import { decimalInput, METALS } from './masters';
import type { PartyRefDto } from './masters';

export const BILL_KINDS = ['SELL', 'PURCHASE'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const BILL_TYPES = ['GST', 'ROUGH'] as const;
export type BillType = (typeof BILL_TYPES)[number];
export const KEEP_BALANCE_AS = ['MONEY', 'GOLD', 'SILVER'] as const;
export const DISCOUNT_UNITS = ['FIXED', 'PERCENT'] as const;
export const BILL_PAYMENT_MODES = ['CASH', 'ONLINE', 'METAL'] as const;
/** Cash received on one sell bill at or above this needs the party's PAN (Income-tax 269ST / PAN rule). */
export const PAN_CASH_LIMIT = 200000;

const weight = z.coerce.number().finite().min(0).max(1_000_000);

export const billLineInput = z.object({
  /** SELL: AVAILABLE stock item in the active branch (TAG = whole item; LOOSE = gross/less/pcs taken from it). Omit for a direct item. */
  stockItemId: id.optional(),
  /** PURCHASE: item name the new stock is created under (required). SELL direct item: optional. */
  itemNameId: id.optional(),
  /** SELL direct item without itemNameId: required description + stockClass */
  description: z.string().trim().max(120).optional(),
  stockClass: z.enum(STOCK_CLASSES).optional(),
  /** PURCHASE TAG items: omit for auto tag */
  tagNo: z.string().trim().toUpperCase().max(30).optional(),
  karatCode: z.string().max(6).optional(),
  pcs: z.coerce.number().int().min(0).default(1),
  gross: weight,
  less: weight.default(0),
  /** omitted → karat mapping / stock item / 100 */
  tunch: z.coerce.number().min(0).max(100).optional(),
  wastage: z.coerce.number().min(0).max(100).default(0),
  stoneCharge: decimalInput.default(0),
  /** SELL: per settings rate unit (gold /10 g, silver /1 kg); PURCHASE: per 1 g */
  rate: decimalInput.default(0),
  labour: decimalInput.default(0),
  labourUnit: z.enum(CHARGE_UNITS).default('PER_GRAM'),
  other: decimalInput.default(0),
  discount: decimalInput.default(0),
  discountUnit: z.enum(DISCOUNT_UNITS).default('FIXED'),
});
export type BillLineInput = z.infer<typeof billLineInput>;

export const billPaymentInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('CASH'), amount: decimalInput.positive(), remark: z.string().max(200).optional() }),
  z.object({ mode: z.literal('ONLINE'), amount: decimalInput.positive(), bankAccountId: id, remark: z.string().max(200).optional() }),
  z.object({
    mode: z.literal('METAL'),
    metal: z.enum(METALS),
    metalForm: z.enum(['BULLION', 'KACHA']),
    gross: weight.positive(),
    less: weight.default(0),
    tunch: z.coerce.number().min(0).max(100),
    /** per settings rate unit; amount = fine × rate / unit */
    rate: decimalInput,
    remark: z.string().max(200).optional(),
  }),
]);
export type BillPaymentInput = z.infer<typeof billPaymentInput>;

export const billBody = z
  .object({
    kind: z.enum(BILL_KINDS),
    billType: z.enum(BILL_TYPES),
    partyId: id,
    billDate: z.coerce.date().optional(),
    dueDate: z.coerce.date().optional(),
    items: z.array(billLineInput).min(1).max(100),
    discount: decimalInput.default(0),
    discountUnit: z.enum(DISCOUNT_UNITS).default('FIXED'),
    /** ignored (0) for ROUGH */
    gstPercent: z.coerce.number().min(0).max(28).default(3),
    payments: z.array(billPaymentInput).max(20).default([]),
    keepBalanceAs: z.enum(KEEP_BALANCE_AS).default('MONEY'),
    /** required when keepBalanceAs is GOLD/SILVER; per settings rate unit */
    keepRate: decimalInput.optional(),
    /** sent when the server answered PAN_REQUIRED; saved onto the party */
    pan: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
      .optional(),
    remark: z.string().trim().max(300).optional(),
    /** SELL from an APPROVED showroom draft (Phase 7): draft → BILLED in the same tx */
    draftId: id.optional(),
    /** SELL delivering a customer order (Phase 8): its RESERVED finished pieces may be sold; order → DELIVERED in the same tx */
    orderId: id.optional(),
  })
  .refine((b) => b.items.every((r) => r.less <= r.gross), { message: 'less cannot exceed gross', path: ['items'] })
  .refine((b) => b.keepBalanceAs === 'MONEY' || (b.keepRate ?? 0) > 0, { message: 'Enter the rate to keep the balance in metal', path: ['keepRate'] });
export type BillBody = z.infer<typeof billBody>;

/** PATCH /app/bills/:id — edit a bill dated TODAY (X-MPIN). Same body as create; kind + billType must not change (number series). */
export const editBillBody = billBody;

export const addBillPaymentsBody =z.object({ payments: z.array(billPaymentInput).min(1).max(20), txnDate: z.coerce.date().optional() });
/** DELETE /app/bills/:id?returnStock=true → items back to stock; false → record only */
export const deleteBillQuery = z.object({ returnStock: z.enum(['true', 'false']).default('true') });

export const billListQuery = pageQuery.extend({
  kind: z.enum(BILL_KINDS),
  billType: z.enum(BILL_TYPES).optional(),
  partyId: id.optional(),
  status: z.enum(['ACTIVE', 'DELETED']).default('ACTIVE'),
  /** only bills with balance ≠ 0 */
  pending: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minTotal: decimalInput.optional(),
  maxTotal: decimalInput.optional(),
});
export const nextBillNoQuery = z.object({ kind: z.enum(BILL_KINDS), billType: z.enum(BILL_TYPES) });

export interface BillLineDto {
  id: number;
  stockItemId: number | null;
  itemNameId: number | null;
  stockClass: (typeof STOCK_CLASSES)[number];
  description: string;
  hsnCode: string | null;
  tagNo: string | null;
  karatCode: string | null;
  pcs: number;
  gross: string;
  less: string;
  net: string;
  tunch: string;
  wastage: string;
  fine: string;
  stoneCharge: string;
  rate: string;
  labour: string;
  labourUnit: (typeof CHARGE_UNITS)[number];
  other: string;
  discount: string;
  discountUnit: (typeof DISCOUNT_UNITS)[number];
  metalAmount: string;
  labourAmount: string;
  total: string;
}

export interface BillPaymentDto {
  id: number;
  mode: (typeof BILL_PAYMENT_MODES)[number];
  bankAccount: { id: number; name: string } | null;
  metal: 'GOLD' | 'SILVER' | null;
  metalForm: 'BULLION' | 'KACHA' | null;
  gross: string | null;
  net: string | null;
  tunch: string | null;
  fine: string | null;
  rate: string | null;
  amount: string;
  remark: string | null;
  txnDate: string;
  isActive: boolean;
  createdAt: string;
}

export interface BillListItemDto {
  id: number;
  kind: BillKind;
  billType: BillType;
  billNo: string;
  billDate: string;
  party: PartyRefDto;
  branch: { id: number; name: string };
  itemCount: number;
  final: string;
  paid: string;
  /** final − paid (negative = advance) */
  balance: string;
  keepBalanceAs: (typeof KEEP_BALANCE_AS)[number];
  keepWeight: string | null;
  status: 'ACTIVE' | 'DELETED';
  createdBy: string | null;
  createdAt: string;
}

export interface BillDto extends BillListItemDto {
  dueDate: string | null;
  interState: boolean;
  sub: string;
  discount: string;
  discountUnit: (typeof DISCOUNT_UNITS)[number];
  discountAmount: string;
  gstPercent: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  round: string;
  keepRate: string | null;
  remark: string | null;
  deletedWithStock: boolean | null;
  items: BillLineDto[];
  payments: BillPaymentDto[];
}
