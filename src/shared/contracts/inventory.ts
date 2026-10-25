/**
 * Phase 2 — inventory contracts (spec: docs/modules/04-inventory.md, routes: docs/api-phase2.md).
 * Weights are 3-dp strings in responses; inputs accept number or numeric string.
 * Server recomputes net/fine with the shared calc engine — client-sent net/fine are ignored.
 */
import { z } from 'zod';
import { STOCK_CLASSES } from '../enums';
import { id, pageQuery } from './common';
import { decimalInput } from './masters';

export const ENTRY_METHODS = ['LOOSE', 'TAG', 'BOTH'] as const;
export const CHARGE_UNITS = ['PER_GRAM', 'PERCENT', 'FIXED'] as const;
export const STOCK_STATUSES = ['AVAILABLE', 'SOLD', 'RESERVED', 'ISSUED', 'TRANSFERRED', 'DELETED'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

const stockClass = z.enum(STOCK_CLASSES);
const weight = z.coerce.number().finite().min(0).max(1_000_000);
const optWeight = weight.optional();

// ───────────── Masters ─────────────

export const jewelleryTypeBody = z.object({ name: z.string().trim().min(2).max(60), stockClass: stockClass.optional() });
export interface JewelleryTypeDto {
  id: number;
  name: string;
  stockClass: (typeof STOCK_CLASSES)[number] | null;
  /** false = global type from the platform list */
  isCustom: boolean;
}

const limits = {
  minWeight: optWeight,
  maxWeight: optWeight,
  minPcs: z.coerce.number().int().min(0).optional(),
  maxPcs: z.coerce.number().int().min(0).optional(),
};

/** Creates one group per name (justudhari's multi-add "type group & press Enter"). */
export const itemGroupBody = z.object({
  stockClass,
  jewelleryTypeId: id.optional(),
  names: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
  hsnId: id.optional(),
  gstRate: z.coerce.number().min(0).max(28).default(3),
  ...limits,
});
export const updateItemGroupBody = itemGroupBody.omit({ names: true }).partial().extend({
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
});
export const itemGroupListQuery = pageQuery.extend({ stockClass: stockClass.optional(), jewelleryTypeId: id.optional() });
export interface ItemGroupDto {
  id: number;
  stockClass: (typeof STOCK_CLASSES)[number];
  name: string;
  jewelleryType: { id: number; name: string } | null;
  hsn: { id: number; code: string } | null;
  gstRate: string;
  minWeight: string | null;
  maxWeight: string | null;
  minPcs: number | null;
  maxPcs: number | null;
  itemCount: number;
  isActive: boolean;
}

export const itemNameBody = z.object({
  groupId: id,
  name: z.string().trim().min(1).max(80),
  hsnId: id.optional(),
  taxValue: z.coerce.number().min(0).optional(),
  taxUnit: z.enum(['PERCENT', 'FIXED']).optional(),
  method: z.enum(ENTRY_METHODS).default('BOTH'),
  tagPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, '1-6 letters/digits')
    .optional(),
  tagDigits: z.coerce.number().int().min(3).max(8).optional(),
  ...limits,
  defKaratCode: z.string().max(6).optional(),
  defTunch: z.coerce.number().min(0).max(100).optional(),
  defWastage: z.coerce.number().min(0).max(100).optional(),
  defLabour: z.coerce.number().min(0).optional(),
  defLabourUnit: z.enum(CHARGE_UNITS).optional(),
});
export const updateItemNameBody = itemNameBody.partial().extend({ isActive: z.boolean().optional() });
export const itemNameListQuery = pageQuery.extend({ stockClass: stockClass.optional(), groupId: id.optional() });
export interface ItemNameDto {
  id: number;
  name: string;
  group: { id: number; name: string; stockClass: (typeof STOCK_CLASSES)[number] };
  hsn: { id: number; code: string } | null;
  taxValue: string | null;
  taxUnit: 'PERCENT' | 'FIXED' | null;
  method: (typeof ENTRY_METHODS)[number];
  tagPrefix: string | null;
  tagDigits: number | null;
  minWeight: string | null;
  maxWeight: string | null;
  minPcs: number | null;
  maxPcs: number | null;
  defKaratCode: string | null;
  defTunch: string | null;
  defWastage: string | null;
  defLabour: string | null;
  defLabourUnit: (typeof CHARGE_UNITS)[number] | null;
  isActive: boolean;
}

// ───────────── Stock entry ─────────────

export const stockRowInput = z.object({
  itemNameId: id,
  /** TAG rows: omit to auto-assign from the item name's prefix/digits (TagSequence) */
  tagNo: z.string().trim().toUpperCase().max(30).optional(),
  huid: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/, 'HUID is 6 characters')
    .optional(),
  karatCode: z.string().max(6).optional(),
  pcs: z.coerce.number().int().min(0).default(1),
  gross: weight,
  less: weight.default(0),
  /** omitted → from karat mapping (gold) or 100 */
  tunch: z.coerce.number().min(0).max(100).optional(),
  wastage: z.coerce.number().min(0).max(100).default(0),
  stoneCharge: decimalInput.default(0),
  labour: decimalInput.default(0),
  labourUnit: z.enum(CHARGE_UNITS).default('PER_GRAM'),
  other: decimalInput.default(0),
  rate: decimalInput.optional(),
  purchaseCost: decimalInput.optional(),
  remarks: z.string().max(300).optional(),
});
export const stockEntryBody = z
  .object({
    stockClass,
    /** LOOSE or TAG (BOTH is only an item-name setting) */
    method: z.enum(['LOOSE', 'TAG']),
    /** default = active branch (X-Branch-Id) */
    branchId: id.optional(),
    txnDate: z.coerce.date().optional(),
    rows: z.array(stockRowInput).min(1).max(500),
  })
  .refine((b) => b.rows.every((r) => r.less <= r.gross), { message: 'less cannot exceed gross', path: ['rows'] });

export const updateStockItemBody = stockRowInput.omit({ itemNameId: true, tagNo: true }).partial();

export const stockListQuery = pageQuery.extend({
  stockClass: stockClass.optional(),
  status: z.enum(STOCK_STATUSES).default('AVAILABLE'),
  method: z.enum(['LOOSE', 'TAG']).optional(),
  groupId: id.optional(),
  itemNameId: id.optional(),
  karatCode: z.string().optional(),
  minWeight: optWeight,
  maxWeight: optWeight,
  /** admins: specific branch or omit for active branch; "all" handled via X-Branch-Id */
  branchId: id.optional(),
});

export interface StockItemDto {
  id: number;
  branch: { id: number; name: string };
  stockClass: (typeof STOCK_CLASSES)[number];
  group: { id: number; name: string };
  itemName: { id: number; name: string };
  hsnCode: string | null;
  method: 'LOOSE' | 'TAG';
  tagNo: string | null;
  huid: string | null;
  karatCode: string | null;
  pcs: number;
  gross: string;
  less: string;
  net: string;
  tunch: string;
  wastage: string;
  fine: string;
  stoneCharge: string;
  labour: string;
  labourUnit: (typeof CHARGE_UNITS)[number];
  other: string;
  rate: string | null;
  purchaseCost: string | null;
  status: StockStatus;
  entryNo: number | null;
  photoUrl: string | null;
  remarks: string | null;
  createdAt: string;
}

export interface StockEntryResultDto {
  entryNo: number;
  items: StockItemDto[];
}

/** Totals per stock class for dashboards (inventory home + main dashboard). */
export interface StockSummaryDto {
  stockClass: (typeof STOCK_CLASSES)[number];
  items: number;
  pcs: number;
  gross: string;
  net: string;
  fine: string;
  /** Σ purchaseCost where known */
  value: string;
}

export interface GroupStockDto {
  groupId: number;
  groupName: string;
  hsnCode: string | null;
  karatCode: string | null;
  items: number;
  pcs: number;
  gross: string;
  net: string;
  fine: string;
  value: string;
}

// ───────────── Import & shortage ─────────────

/** CSV columns (header row required, case-insensitive): item_name, tag_no, huid, karat, pcs, gross, less, tunch, wastage, stone_charge, labour, labour_unit, other, rate, purchase_cost, remarks */
export const STOCK_CSV_COLUMNS = [
  'item_name',
  'tag_no',
  'huid',
  'karat',
  'pcs',
  'gross',
  'less',
  'tunch',
  'wastage',
  'stone_charge',
  'labour',
  'labour_unit',
  'other',
  'rate',
  'purchase_cost',
  'remarks',
] as const;
export const stockImportFields = z.object({
  stockClass,
  method: z.enum(['LOOSE', 'TAG']),
  groupId: id,
  /** true = validate only, nothing saved */
  dryRun: z.enum(['true', 'false']).default('true'),
});
export interface StockImportResultDto {
  dryRun: boolean;
  total: number;
  valid: number;
  imported: number;
  errors: Array<{ row: number; field?: string; message: string }>;
  entryNo: number | null;
}

export const shortageQuery = z.object({
  stockClass: stockClass.optional(),
  jewelleryTypeId: id.optional(),
  status: z.enum(['SHORTAGE', 'WARNING', 'OK']).optional(),
  q: z.string().trim().optional(),
});
export interface ShortageRowDto {
  level: 'GROUP' | 'ITEM';
  id: number;
  name: string;
  stockClass: (typeof STOCK_CLASSES)[number];
  jewelleryType: string | null;
  currentWeight: string;
  currentPcs: number;
  minWeight: string | null;
  maxWeight: string | null;
  minPcs: number | null;
  maxPcs: number | null;
  /** SHORTAGE: below min; WARNING: within 20% above min; OK otherwise */
  status: 'SHORTAGE' | 'WARNING' | 'OK';
}

// ───────────── Phase 2b: bulk actions, stock transfer ─────────────

/** Bulk edit on checked rows (All Stock list): same fields as single edit, applied to every id (only AVAILABLE). */
export const bulkStockEditBody = z.object({ ids: z.array(id).min(1).max(500), patch: updateStockItemBody });
/** Bulk delete (X-MPIN): status DELETED + ledger reverse per item, one transaction. */
export const bulkStockDeleteBody = z.object({ ids: z.array(id).min(1).max(500) });
export interface BulkResultDto {
  updated: number;
}

/** Inter-branch transfer of whole AVAILABLE items. Both branches must be in the user's subtree. */
export const stockTransferBody = z
  .object({
    fromBranchId: id,
    toBranchId: id,
    stockItemIds: z.array(id).min(1).max(500),
    remarks: z.string().trim().max(300).optional(),
  })
  .refine((b) => b.fromBranchId !== b.toBranchId, { message: 'Choose a different branch', path: ['toBranchId'] });
export const stockTransferListQuery = pageQuery.extend({ branchId: id.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
export interface StockTransferDto {
  id: number;
  transferNo: number;
  txnDate: string;
  fromBranch: { id: number; name: string };
  toBranch: { id: number; name: string };
  itemCount: number;
  /** Σ of moved items, main units */
  gross: string;
  fine: string;
  remarks: string | null;
  createdBy: string | null;
  createdAt: string;
}
export interface StockTransferDetailDto extends StockTransferDto {
  items: StockItemDto[];
}
