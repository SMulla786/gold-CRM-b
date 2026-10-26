/**
 * Phase 8 — customer orders, karigar job work, repair (spec: docs/modules/03-orders-karigar.md, 07 §7.1;
 * routes: docs/api-phase8.md). Sign conventions for party balances as in udhari (+ = party owes the shop).
 */
import { z } from 'zod';
import { id, pageQuery } from './common';
import { CHARGE_UNITS } from './inventory';
import { billPaymentInput } from './billing';
import type { BillPaymentDto } from './billing';
import { decimalInput, METALS } from './masters';
import type { PartyRefDto } from './masters';

const weight = z.coerce.number().finite().min(0).max(1_000_000);

// ───────────── Orders ─────────────

export const ORDER_STATUSES = ['PENDING', 'IN_PROCESS', 'READY', 'DELIVERED', 'CANCELLED'] as const;
export const ORDER_ITEM_STATUSES = ['PENDING', 'ASSIGNED', 'RECEIVED', 'DELIVERED'] as const;

export const orderItemInput = z
  .object({
    itemNameId: id,
    metal: z.enum(METALS),
    karatCode: z.string().max(6).optional(),
    /** omitted → karat mapping touch */
    touch: z.coerce.number().min(0).max(100).optional(),
    size: z.string().trim().max(20).optional(),
    pcs: z.coerce.number().int().min(1).default(1),
    gross: weight.positive(),
    less: weight.default(0),
    wastage: z.coerce.number().min(0).max(100).default(0),
    making: decimalInput.default(0),
    makingUnit: z.enum(CHARGE_UNITS).default('PER_GRAM'),
    other: decimalInput.default(0),
    remark: z.string().trim().max(200).optional(),
    /** TASK-97: flat labour Rs for the line (added to the line estimate) */
    labour: decimalInput.default(0),
    /** TASK-97: wastage in fine grams, added to the line fine (and to the metal value when the sale basis is FINE) */
    wastageGm: weight.default(0),
    jewelleryTypeId: id.optional(),
  })
  .refine((r) => r.less <= r.gross, { message: 'less cannot exceed gross', path: ['less'] });

export const orderBody = z.object({
  partyId: id,
  orderDate: z.coerce.date().optional(),
  deliveryDate: z.coerce.date().optional(),
  rateType: z.enum(['FIXED', 'ON_DELIVERY']).default('ON_DELIVERY'),
  isUrgent: z.boolean().default(false),
  remark: z.string().trim().max(300).optional(),
  items: z.array(orderItemInput).min(1).max(50),
  /** advance: CASH / ONLINE / METAL (KACHA or BULLION) */
  payments: z.array(billPaymentInput).max(10).default([]),
  /** TASK-97: order-level misc charges (Rs), added to estTotal */
  miscCharges: decimalInput.default(0),
  /** TASK-97: rate override per settings unit (gold per 10 g etc.) — used instead of today's rate for estTotal and the FIXED lock */
  goldRate: decimalInput.optional(),
  silverRate: decimalInput.optional(),
});
export const addOrderAdvanceBody = z.object({ payments: z.array(billPaymentInput).min(1).max(10) });
export const orderListQuery = pageQuery.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  partyId: id.optional(),
  /** TASK-97: comma list of ORDER_STATUSES (e.g. "PENDING,IN_PROCESS"); combined with `status` when both are given */
  statuses: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(ORDER_STATUSES)).optional()),
});

/** TASK-98: GET /orders/next-no — the order no. the next create in the active branch would get (peek, not reserved). */
export interface OrderNextNoDto {
  nextNo: number;
}
/** TASK-98: POST /orders/bulk-cancel ('delete' in the UI = cancel; same rules as POST /orders/:id/cancel, one tx per order). */
export const bulkCancelOrdersBody = z.object({ ids: z.array(id).min(1).max(100) });
export interface BulkCancelOrdersResultDto {
  cancelled: number[];
  failed: Array<{ id: number; reason: string }>;
}

export interface OrderItemDto {
  id: number;
  itemName: { id: number; name: string };
  metal: 'GOLD' | 'SILVER';
  karatCode: string | null;
  touch: string;
  size: string | null;
  pcs: number;
  gross: string;
  less: string;
  net: string;
  wastage: string;
  fine: string;
  making: string;
  makingUnit: (typeof CHARGE_UNITS)[number];
  other: string;
  estTotal: string;
  remark: string | null;
  status: (typeof ORDER_ITEM_STATUSES)[number];
  karigarIssue: { id: number; issueNo: number; karigar: { id: number; name: string } } | null;
  stockItemId: number | null;
  returnedGross: string | null;
  returnedNet: string | null;
  returnedFine: string | null;
  ghatAllowance: string | null;
  karigarLabour: string | null;
  /** TASK-97 */
  labour: string;
  wastageGm: string;
  jewelleryTypeId: number | null;
}

export interface OrderDto {
  id: number;
  orderNo: number;
  orderDate: string;
  deliveryDate: string | null;
  party: PartyRefDto;
  branch: { id: number; name: string };
  rateType: 'FIXED' | 'ON_DELIVERY';
  goldRate: string | null;
  silverRate: string | null;
  isUrgent: boolean;
  remark: string | null;
  status: (typeof ORDER_STATUSES)[number];
  estTotal: string;
  advance: string;
  billId: number | null;
  /** TASK-97 */
  miscCharges: string;
  /** set → GET /app/orders/:id/design streams the file (image or PDF) */
  designUrl: string | null;
  items: OrderItemDto[];
  payments: BillPaymentDto[];
  createdBy: string | null;
  createdAt: string;
}

// ───────────── Karigar issue / receive ─────────────

export const karigarIssueBody = z
  .object({
    karigarId: id,
    orderItemIds: z.array(id).min(1).max(50),
    dueDate: z.coerce.date().optional(),
    /** material handed over now */
    goldFine: weight.default(0),
    silverFine: weight.default(0),
    cash: decimalInput.default(0),
    online: decimalInput.default(0),
    bankAccountId: id.optional(),
    remark: z.string().trim().max(300).optional(),
    /** TASK-97: agreed karigar wastage — stored for reference only (no posting) */
    wastagePercent: z.coerce.number().min(0).max(100).optional(),
    wastageGm: weight.optional(),
  })
  .refine((b) => b.online === 0 || b.bankAccountId != null, { message: 'Select a bank account', path: ['bankAccountId'] });

export const karigarReceiveBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: id,
        returnedGross: weight.positive(),
        returnedLess: weight.default(0),
        /** omitted → the order item's touch */
        touch: z.coerce.number().min(0).max(100).optional(),
        /** fine weight the karigar may lose (ghat) */
        ghatAllowance: weight.default(0),
        /** labour the shop owes the karigar for this piece */
        labour: decimalInput.default(0),
        /** optional tag for the finished piece; omitted → auto from the item name */
        tagNo: z.string().trim().toUpperCase().max(30).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export const karigarIssueListQuery = pageQuery.extend({ karigarId: id.optional(), status: z.enum(['OPEN', 'RECEIVED', 'CANCELLED']).optional() });

export interface KarigarIssueDto {
  id: number;
  issueNo: number;
  issueDate: string;
  dueDate: string | null;
  karigar: PartyRefDto;
  goldFine: string;
  silverFine: string;
  cash: string;
  online: string;
  bankAccount: { id: number; name: string } | null;
  remark: string | null;
  status: 'OPEN' | 'RECEIVED' | 'CANCELLED';
  /** TASK-97 (info only) */
  wastagePercent: string | null;
  wastageGm: string | null;
  items: Array<OrderItemDto & { order: { id: number; orderNo: number; party: PartyRefDto } }>;
  createdAt: string;
}

// ───────────── Repair ─────────────

export const REPAIR_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'IN_REVIEW', 'READY', 'DELIVERED', 'CANCELLED'] as const;

export const repairBody = z
  .object({
    partyId: id,
    metal: z.enum(['GOLD', 'SILVER', 'OTHER']),
    category: z.string().trim().min(1).max(40),
    description: z.string().trim().min(2).max(300),
    pcs: z.coerce.number().int().min(1).default(1),
    gross: weight.positive(),
    net: weight.optional(),
    karatCode: z.string().max(6).optional(),
    hallmark: z.string().trim().max(30).optional(),
    expectedDate: z.coerce.date(),
    priority: z.enum(['NORMAL', 'URGENT', 'EXPRESS']).default('NORMAL'),
    karigarId: id.optional(),
    labourCharge: decimalInput.default(0),
    otherCharge: decimalInput.default(0),
    advanceCash: decimalInput.default(0),
    advanceOnline: decimalInput.default(0),
    advanceBankId: id.optional(),
    /** TASK-97: purity % and sub-category */
    purity: z.coerce.number().min(0).max(100).optional(),
    subCategory: z.string().trim().max(40).optional(),
  })
  .refine((b) => b.advanceOnline === 0 || b.advanceBankId != null, { message: 'Select a bank account', path: ['advanceBankId'] });

export const repairStatusBody = z.object({
  status: z.enum(['IN_PROGRESS', 'IN_REVIEW', 'READY', 'CANCELLED']),
  karigarId: id.optional(),
  /** IN_REVIEW → READY (quality audit) */
  finalWeight: weight.optional(),
  remarks: z.string().trim().max(300).optional(),
});

export const repairDeliverBody = z
  .object({
    /** shop metal added (solder) — shop GOLD/SILVER OUT; OTHER = value billed only, no stock/ledger metal posting */
    addedMetal: z.enum(['GOLD', 'SILVER', 'OTHER']).optional(),
    addedKaratCode: z.string().trim().max(6).optional(),
    addedFine: weight.default(0),
    addedRate: decimalInput.default(0),
    cash: decimalInput.default(0),
    online: decimalInput.default(0),
    bankAccountId: id.optional(),
    remarks: z.string().trim().max(300).optional(),
  })
  .refine((b) => b.online === 0 || b.bankAccountId != null, { message: 'Select a bank account', path: ['bankAccountId'] })
  .refine((b) => b.addedFine === 0 || b.addedMetal != null, { message: 'Pick the metal added', path: ['addedMetal'] });

export const repairListQuery = pageQuery.extend({
  status: z.enum(REPAIR_STATUSES).optional(),
  partyId: id.optional(),
  /** TASK-97: ticket metal + createdAt range (business dates, inclusive) */
  metal: z.enum(['GOLD', 'SILVER', 'OTHER']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export interface RepairTicketDto {
  id: number;
  ticketNo: number;
  party: PartyRefDto;
  metal: 'GOLD' | 'SILVER' | 'OTHER';
  category: string;
  description: string;
  pcs: number;
  gross: string;
  net: string | null;
  karatCode: string | null;
  hallmark: string | null;
  /** TASK-97 */
  purity: string | null;
  subCategory: string | null;
  /** set → GET /app/repairs/:id/photo streams it */
  photoUrl: string | null;
  expectedDate: string;
  priority: 'NORMAL' | 'URGENT' | 'EXPRESS';
  status: (typeof REPAIR_STATUSES)[number];
  karigar: { id: number; name: string } | null;
  labourCharge: string;
  otherCharge: string;
  advance: string;
  finalWeight: string | null;
  remarks: string | null;
  /** labour + other + added metal value − advance − delivery payments (≥ 0 → party owes) */
  balance: string;
  deliveredAt: string | null;
  createdAt: string;
  /** TASK-97 settlement breakdown (null until delivered / when not used) */
  addedMetal: 'GOLD' | 'SILVER' | 'OTHER' | null;
  addedFine: string | null;
  addedRate: string | null;
  addedKaratCode: string | null;
  deliveryCash: string | null;
  deliveryOnline: string | null;
  deliveryBank: { id: number; name: string } | null;
}

// TASK-97 repair consumables (solder, wire, polish …) — per-branch stock count, no ledger posting
export const repairConsumableBody = z.object({
  name: z.string().trim().min(1).max(60),
  category: z.string().trim().max(40).optional(),
  unit: z.string().trim().min(1).max(10).default('pcs'),
  currentStock: weight.default(0),
  minLevel: weight.default(0),
  isActive: z.boolean().default(true),
});
export const updateRepairConsumableBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  category: z.string().trim().max(40).nullable().optional(),
  unit: z.string().trim().min(1).max(10).optional(),
  currentStock: weight.optional(),
  minLevel: weight.optional(),
  isActive: z.boolean().optional(),
});
export const repairConsumableAdjustBody = z.object({
  delta: z.coerce.number().finite().refine((n) => n !== 0, 'Enter a non-zero quantity'),
  reason: z.string().trim().max(200).optional(),
});

export interface RepairConsumableDto {
  id: number;
  name: string;
  category: string | null;
  unit: string;
  currentStock: string;
  minLevel: string;
  isActive: boolean;
  /** OUT when stock ≤ 0, LOW when stock ≤ minLevel */
  status: 'OK' | 'LOW' | 'OUT';
  updatedAt: string;
}
