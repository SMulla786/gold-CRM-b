/**
 * Phase 2 — inventory contracts (spec: docs/modules/04-inventory.md, routes: docs/api-phase2.md).
 * Weights are 3-dp strings in responses; inputs accept number or numeric string.
 * Server recomputes net/fine with the shared calc engine — client-sent net/fine are ignored.
 */
import { z } from 'zod';
import { STOCK_CLASSES } from '../enums';
import { id, pageQuery } from './common';
import type { Paged } from './common';
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
/** Edit may send null to clear an optional field (HSN, type, limits). */
const nullableLimits = {
  minWeight: weight.nullable().optional(),
  maxWeight: weight.nullable().optional(),
  minPcs: z.coerce.number().int().min(0).nullable().optional(),
  maxPcs: z.coerce.number().int().min(0).nullable().optional(),
};
export const updateItemGroupBody = itemGroupBody.omit({ names: true }).partial().extend({
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
  jewelleryTypeId: id.nullable().optional(),
  hsnId: id.nullable().optional(),
  ...nullableLimits,
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
export const updateItemNameBody = itemNameBody.partial().extend({
  isActive: z.boolean().optional(),
  hsnId: id.nullable().optional(),
  taxValue: z.coerce.number().min(0).nullable().optional(),
  taxUnit: z.enum(['PERCENT', 'FIXED']).nullable().optional(),
  ...nullableLimits,
  defKaratCode: z.string().max(6).nullable().optional(),
  defTunch: z.coerce.number().min(0).max(100).nullable().optional(),
  defWastage: z.coerce.number().min(0).max(100).nullable().optional(),
  defLabour: z.coerce.number().min(0).nullable().optional(),
  defLabourUnit: z.enum(CHARGE_UNITS).nullable().optional(),
});
export const itemNameListQuery = pageQuery.extend({
  stockClass: stockClass.optional(),
  groupId: id.optional(),
  /** TASK-98: filter by the item group's jewellery type */
  jewelleryTypeId: id.optional(),
});
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

/** TASK-98: what the printed tag encodes. RFID = EPC code stored on the item (no reader hardware). */
export const STOCK_CODE_TYPES = ['BARCODE', 'QR', 'RFID'] as const;
export type StockCodeType = (typeof STOCK_CODE_TYPES)[number];
const epcCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-F]{8,64}$/, 'EPC is 8-64 hex characters');

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
  /** TASK-98: label code type (default BARCODE) + RFID EPC (unique per business) */
  codeType: z.enum(STOCK_CODE_TYPES).optional(),
  epcCode: epcCode.optional(),
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

/** TASK-98: epcCode null clears it. */
export const updateStockItemBody = stockRowInput.omit({ itemNameId: true, tagNo: true }).partial().extend({ epcCode: epcCode.nullable().optional() });

/** Stock list status filter: a real status, or ALL = every status except DELETED. */
export const STOCK_LIST_STATUSES = [...STOCK_STATUSES, 'ALL'] as const;
export const stockListQuery = pageQuery.extend({
  stockClass: stockClass.optional(),
  status: z.enum(STOCK_LIST_STATUSES).default('AVAILABLE'),
  /** item group's jewellery type (collection) */
  jewelleryTypeId: id.optional(),
  method: z.enum(['LOOSE', 'TAG']).optional(),
  groupId: id.optional(),
  itemNameId: id.optional(),
  karatCode: z.string().optional(),
  minWeight: optWeight,
  maxWeight: optWeight,
  /** admins: specific branch or omit for active branch; "all" handled via X-Branch-Id */
  branchId: id.optional(),
  /** TASK-98 */
  codeType: z.enum(STOCK_CODE_TYPES).optional(),
});

/** TASK-98: GET /stock/next-tag — peek the next auto tag no. without consuming it. */
export const nextTagQuery = z.object({ itemNameId: id });
export interface NextTagDto {
  /** null when the item name has no tag prefix/digits (manual tag needed) */
  tagNo: string | null;
  prefix: string | null;
  next: number | null;
}

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
  /** TASK-98 — always sent by the API (optional only so older hand-built literals keep compiling) */
  codeType?: StockCodeType;
  epcCode?: string | null;
}

/** GET /stock — totals are over ALL filtered rows, not just the page. */
export interface StockListPage extends Paged<StockItemDto> {
  totals?: { pcs: number; gross: string; net: string; fine: string };
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
  /**
   * SHORTAGE: below min; WARNING: within 20% above min; OK otherwise.
   * Weight (minWeight) and pcs (minPcs) are each checked when set and the worse result wins;
   * pcs above maxPcs is also a WARNING (overstock). With pcs limits null only the weight rule applies.
   */
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

// ───────────── Printer settings (Setting key 'inventory.printer') ─────────────

export const PRINTER_TYPES = ['THERMAL_LABEL', 'ZEBRA', 'A4_SHEET'] as const;
const mm = (max: number) => z.coerce.number().finite().min(0).max(max);
/** PUT body; every field has a default so GET can return a full DTO when nothing is saved yet. */
export const printerSettingsBody = z.object({
  printerType: z.enum(PRINTER_TYPES).default('A4_SHEET'),
  labelWidthMm: mm(300).min(5).default(60),
  labelHeightMm: mm(300).min(5).default(30),
  columns: z.coerce.number().int().min(1).max(6).default(3),
  gapMm: mm(50).default(2),
  marginMm: mm(50).default(5),
});
export type PrinterSettingsDto = z.output<typeof printerSettingsBody>;

// ───────────── Tag templates (Tag Editor) ─────────────

export const TAG_SHAPES = ['RECT', 'ROUNDED', 'BUTTERFLY'] as const;
export const TAG_DIRECTIONS = ['HORIZONTAL', 'VERTICAL'] as const;
/** TASK-98: 'qr' = QR code of a field (same binding as barcode). */
export const TAG_ELEMENT_TYPES = ['text', 'field', 'barcode', 'image', 'qr'] as const;
/** Data a field/barcode/qr element prints. image = the shop's invoice logo. epcCode = RFID EPC (TASK-98). */
export const TAG_FIELDS = ['tagNo', 'huid', 'itemName', 'karat', 'gross', 'net', 'fine', 'rate', 'shopName', 'epcCode'] as const;
export type TagField = (typeof TAG_FIELDS)[number];
export const tagElement = z.object({
  id: z.string().trim().min(1).max(40),
  type: z.enum(TAG_ELEMENT_TYPES),
  /** position/size in mm from the label's top-left */
  x: mm(300),
  y: mm(300),
  w: mm(300),
  h: mm(300),
  angle: z.coerce.number().min(-360).max(360).optional(),
  /** pt */
  fontSize: z.coerce.number().min(1).max(72).optional(),
  bold: z.boolean().optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'Hex colour like #000000').optional(),
  /** 0..1 */
  opacity: z.coerce.number().min(0).max(1).optional(),
  /** type text */
  text: z.string().max(200).optional(),
  /** type field / barcode / qr */
  field: z.enum(TAG_FIELDS).optional(),
});
export type TagElement = z.infer<typeof tagElement>;
export const tagTemplateBody = z.object({
  name: z.string().trim().min(1).max(60),
  widthMm: mm(300).min(5),
  heightMm: mm(300).min(5),
  shape: z.enum(TAG_SHAPES).default('RECT'),
  direction: z.enum(TAG_DIRECTIONS).default('HORIZONTAL'),
  neckWidthMm: mm(300).optional(),
  elements: z.array(tagElement).max(50),
  appliesTo: z.array(stockClass).max(STOCK_CLASSES.length).default([]),
});
export const updateTagTemplateBody = tagTemplateBody.partial();
export interface TagTemplateDto {
  id: number;
  name: string;
  widthMm: number;
  heightMm: number;
  shape: (typeof TAG_SHAPES)[number];
  direction: (typeof TAG_DIRECTIONS)[number];
  neckWidthMm: number | null;
  elements: TagElement[];
  appliesTo: (typeof STOCK_CLASSES)[number][];
  /** one active template per stock class per business */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ───────────── All Stock Summary + Set Stock ─────────────

/** Weights are fine grams (3 dp), money 2 dp. Scope = active branch, or every branch in the subtree for "all". */
export interface AllStockSummaryDto {
  /** ledger fine of GOLD in every form except kacha (stock + bullion + loose fine) */
  fineGold: string;
  fineSilver: string;
  kacchaGold: string;
  kacchaSilver: string;
  girvi: { activeCount: number; principal: string; gold: string; silver: string };
  udhari: { amount: string; gold: string; silver: string };
  shopCash: string;
  bank: string;
  /** (fineGold + kacchaGold + udhari.gold) × goldRatePerGram + same for silver + shopCash + bank + udhari.amount + girvi.principal */
  totalAmount: string;
  /** today's sell rate of the highest karat, per gram; null when no rate is set (metal then counts as 0) */
  goldRatePerGram: string | null;
  silverRatePerGram: string | null;
}

export const SET_STOCK_CARDS = ['SHOP_CASH', 'FINE_GOLD', 'FINE_SILVER', 'KACCHA_GOLD', 'KACCHA_SILVER'] as const;
export type SetStockCard = (typeof SET_STOCK_CARDS)[number];
/** POST /stock/all-summary/set (X-MPIN). Posts one SET_STOCK ledger row for the difference at the active branch. */
export const setStockBody = z.object({
  card: z.enum(SET_STOCK_CARDS),
  newBalance: z.coerce.number().finite().min(0).max(1_000_000_000),
  remarks: z.string().trim().max(300).optional(),
});
export const setStockLogQuery = pageQuery.extend({ card: z.enum(SET_STOCK_CARDS).optional() });
export interface SetStockLogDto {
  id: number;
  card: SetStockCard;
  branch: { id: number; name: string };
  oldBalance: string;
  newBalance: string;
  /** newBalance − oldBalance */
  difference: string;
  remarks: string | null;
  user: string | null;
  createdAt: string;
}
