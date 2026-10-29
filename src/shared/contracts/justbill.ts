/**
 * Phase 7 — Just Bill (quick calculator bill, no stock) + showroom drafts (spec: docs/modules/02-billing.md §2.3, §2.7;
 * routes: docs/api-phase7.md).
 */
import { z } from 'zod';
import { id, mobile, pageQuery } from './common';
import { CHARGE_UNITS } from './inventory';
import { billPayInput, DISCOUNT_UNITS } from './billing';
import type { BillPaymentDto } from './billing';
import { decimalInput } from './masters';
import type { PartyRefDto } from './masters';

export const QTY_UNITS = ['GRAM', 'PCS'] as const;

export const justBillLineInput = z.object({
  name: z.string().trim().min(1).max(120),
  karat: z.string().trim().max(20).optional(),
  purity: z.coerce.number().min(0).max(100).optional(),
  quantity: z.coerce.number().finite().positive().max(1_000_000),
  unit: z.enum(QTY_UNITS).default('GRAM'),
  /** per gram (GRAM) or per piece (PCS) */
  rate: decimalInput.default(0),
  /** making: PER_GRAM × quantity (GRAM only), PERCENT of quantity × rate, FIXED */
  making: decimalInput.default(0),
  makingUnit: z.enum(CHARGE_UNITS).default('PER_GRAM'),
  other: decimalInput.default(0),
});
export type JustBillLineInput = z.infer<typeof justBillLineInput>;

/**
 * TASK-98: Just Bill payments = the sell-bill pay input (billPayInput): CASH / ONLINE / METAL + the no-cash modes
 * SCHEME (redeems the linked party's enrollment, uses `amount` of its value, 409 if more) and UDHAR_ADVANCE (uses `amount` of the
 * party's existing udhar credit, 409 OVER_BALANCE if more). Neither no-cash mode moves cash/bank. billPaymentInput stays unchanged (order advances use it).
 */
export const justBillPayInput = billPayInput;
export type JustBillPayInput = z.infer<typeof justBillPayInput>;

export const justBillBody = z
  .object({
    /** link a party (balance goes to their udhar) or give a walk-in name */
    partyId: id.optional(),
    customerName: z.string().trim().min(1).max(120).optional(),
    mobile: mobile.optional(),
    billDate: z.coerce.date().optional(),
    items: z.array(justBillLineInput).min(1).max(100),
    discount: decimalInput.default(0),
    discountUnit: z.enum(DISCOUNT_UNITS).default('FIXED'),
    gstPercent: z.coerce.number().min(0).max(28).default(0),
    /** CASH / ONLINE / METAL (KACHA = old gold/silver received) + SCHEME (party's enrollment) + UDHAR_ADVANCE (party's credit) */
    payments: z.array(justBillPayInput).max(20).default([]),
    remark: z.string().trim().max(300).optional(),
  })
  .refine((b) => b.partyId != null || !!b.customerName, { message: 'Pick a party or enter the customer name', path: ['customerName'] });
export type JustBillBody = z.infer<typeof justBillBody>;

export const justBillListQuery = pageQuery.extend({
  partyId: id.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['ACTIVE', 'DELETED']).default('ACTIVE'),
});

export interface JustBillLineDto {
  id: number;
  name: string;
  karat: string | null;
  purity: string | null;
  quantity: string;
  unit: (typeof QTY_UNITS)[number];
  rate: string;
  making: string;
  makingUnit: (typeof CHARGE_UNITS)[number];
  other: string;
  total: string;
  /** line photo: GET /api/app/justbill/items/:id/photo (null when none) */
  photoUrl?: string | null;
}

export interface JustBillListItemDto {
  id: number;
  billNo: string;
  billDate: string;
  party: PartyRefDto | null;
  customerName: string;
  mobile: string | null;
  itemCount: number;
  /** Σ quantity of GRAM lines */
  weight: string;
  sub: string;
  discountAmount: string;
  gst: string;
  final: string;
  paid: string;
  balance: string;
  status: 'ACTIVE' | 'DELETED';
  createdBy: string | null;
  createdAt: string;
}

export interface JustBillDto extends JustBillListItemDto {
  interState: boolean;
  discount: string;
  discountUnit: (typeof DISCOUNT_UNITS)[number];
  gstPercent: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  round: string;
  remark: string | null;
  items: JustBillLineDto[];
  payments: BillPaymentDto[];
}

// ───────────── Showroom drafts ─────────────

export const DRAFT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'BILLED', 'EXPIRED', 'CANCELLED'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Salesperson checks out a cart from the stock list. */
export const salesDraftBody = z
  .object({
    stockItemIds: z.array(id).min(1).max(50),
    partyId: id.optional(),
    customerName: z.string().trim().min(1).max(120).optional(),
    mobile: mobile.optional(),
    requestedDiscount: decimalInput.default(0),
    requestedDiscountUnit: z.enum(DISCOUNT_UNITS).default('FIXED'),
    note: z.string().trim().max(300).optional(),
  })
  .refine((b) => b.partyId != null || !!b.customerName, { message: 'Pick a party or enter the customer name', path: ['customerName'] });

export const draftDecisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('APPROVE'), approvedDiscount: decimalInput, approvedDiscountUnit: z.enum(DISCOUNT_UNITS) }),
  z.object({ decision: z.literal('REJECT'), rejectionReason: z.string().trim().min(2).max(300) }),
]);

export const draftListQuery = pageQuery.extend({ status: z.enum(DRAFT_STATUSES).optional() });

export interface SalesDraftDto {
  id: number;
  draftNo: number;
  createdAt: string;
  salesman: { id: number; name: string };
  party: PartyRefDto | null;
  customerName: string;
  mobile: string | null;
  items: Array<{ stockItemId: number; label: string; tagNo: string | null; gross: string; available: boolean }>;
  estTotal: string;
  requestedDiscount: string;
  requestedDiscountUnit: (typeof DISCOUNT_UNITS)[number];
  approvedDiscount: string | null;
  approvedDiscountUnit: (typeof DISCOUNT_UNITS)[number] | null;
  note: string | null;
  /** EXPIRED is derived on read when PENDING/APPROVED and past expiresAt */
  status: DraftStatus;
  rejectionReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  billId: number | null;
  expiresAt: string;
}
