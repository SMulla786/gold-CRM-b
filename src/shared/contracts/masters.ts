/**
 * Phase 1 — masters & settings contracts (spec: docs/modules/11-masters-settings.md, routes: docs/api-phase1.md).
 * Decimals in responses are strings; inputs accept number or numeric string.
 */
import { z } from 'zod';
import { gstin, id, mobile, pageQuery } from './common';
import { LEDGER_ASSETS, LEDGER_SOURCES } from '../enums';

const optStr = (max = 200) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));
const dateStr = z.coerce.date().optional();
export const decimalInput = z.coerce.number().finite().nonnegative();

// ───────────── Parties ─────────────

export const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER', 'KARIGAR', 'WHOLESALER'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const partyBody = z.object({
  type: z.enum(PARTY_TYPES),
  /** family sub-profile: parent must be a CUSTOMER of the same business */
  parentId: id.optional(),
  name: z.string().trim().min(2).max(120),
  countryCode: z.string().default('+91'),
  mobile,
  email: z.string().email().optional().or(z.literal('').transform(() => undefined)),
  address: optStr(500),
  birthday: dateStr,
  anniversary: dateStr,
  aadhaar: z.string().regex(/^\d{12}$/, '12 digits').optional().or(z.literal('').transform(() => undefined)),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  gstin: gstin.optional().or(z.literal('').transform(() => undefined)),
  licenseNo: optStr(60),
  regNo: optStr(60),
  logoTitle: optStr(120),
  shopName: optStr(120),
  stateId: id.optional(),
  districtId: id.optional(),
  area: optStr(120),
  shopAddress: optStr(500),
  pinCode: z.string().regex(/^\d{6}$/, '6 digits').optional().or(z.literal('').transform(() => undefined)),
  specialty: optStr(120),
});
export const updatePartyBody = partyBody.partial().extend({ isActive: z.boolean().optional() });
export const partyListQuery = pageQuery.extend({
  type: z.enum(PARTY_TYPES).optional(),
  active: z.enum(['true', 'false']).optional(),
});
/** DELETE /parties/:id — a hard delete (only for a party with no history at all) needs ?confirm=true. */
export const deletePartyQuery = z.object({ confirm: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });
/**
 * Dues or a pending bill → 409 PARTY_HAS_DUES / PARTY_HAS_PENDING_BILLS. Any history (bills, udhar, ledger, trade, orders,
 * family members…) → ARCHIVED (isActive=false, rows untouched). No history → 409 CONFIRM_REQUIRED, or DELETED when confirmed.
 */
export interface DeletePartyResultDto {
  result: 'ARCHIVED' | 'DELETED';
}
export const partySearchQuery = z.object({
  q: z.string().trim().min(1),
  type: z.enum(PARTY_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

/** Compact row for pickers / typeahead. */
export interface PartyRefDto {
  id: number;
  type: PartyType;
  name: string;
  mobile: string;
  shopName: string | null;
}
export interface PartyListItemDto extends PartyRefDto {
  parent: { id: number; name: string } | null;
  memberCount: number;
  isActive: boolean;
  createdAt: string;
}
export interface PartyDto extends PartyListItemDto {
  countryCode: string;
  email: string | null;
  address: string | null;
  birthday: string | null;
  anniversary: string | null;
  aadhaar: string | null;
  pan: string | null;
  gstin: string | null;
  licenseNo: string | null;
  regNo: string | null;
  logoTitle: string | null;
  stateId: number | null;
  districtId: number | null;
  area: string | null;
  shopAddress: string | null;
  pinCode: string | null;
  specialty: string | null;
  photoUrl: string | null;
  shopLogoUrl: string | null;
  members: PartyRefDto[];
}

// ───────────── Bank accounts ─────────────

export const BANK_APPLY_TO = ['ALL', 'SYSTEM', 'JUST_BILL', 'STOCK_BILL', 'STOCK_AND_JUST_BILL'] as const;
export const bankAccountBody = z.object({
  /** 0 = all branches of the business */
  branchId: z.coerce.number().int().min(0).default(0),
  bankName: z.string().trim().min(2).max(120),
  branchName: optStr(120),
  accountNo: z.string().trim().regex(/^\d{6,20}$/, '6-20 digits'),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC'),
  applyTo: z.enum(BANK_APPLY_TO).default('ALL'),
  isActive: z.boolean().default(true),
});
export interface BankAccountDto {
  id: number;
  branchId: number;
  branchName: string | null;
  bankName: string;
  bankBranchName: string | null;
  accountNo: string;
  ifsc: string;
  applyTo: (typeof BANK_APPLY_TO)[number];
  isActive: boolean;
}

// ───────────── HSN ─────────────

export const HSN_CATEGORIES = ['GOLD', 'SILVER', 'ARTIFICIAL', 'STONE', 'FRANCHISE', 'FINDINGS'] as const;
export const hsnListQuery = z.object({
  q: z.string().trim().optional(),
  category: z.enum(HSN_CATEGORIES).optional(),
  onlyActive: z.enum(['true', 'false']).optional(),
});
export const hsnToggleBody = z.object({ active: z.boolean() });
export interface HsnDto {
  id: number;
  code: string;
  category: (typeof HSN_CATEGORIES)[number];
  productType: string;
  gstRate: string;
  /** enabled for this business */
  active: boolean;
}

// ───────────── Karat / touch mapping ─────────────

export const METALS = ['GOLD', 'SILVER'] as const;
export type Metal = (typeof METALS)[number];
export const karatBody = z.object({
  metal: z.enum(METALS),
  code: z.string().trim().regex(/^[0-9A-Za-z]{1,6}$/),
  title: z.string().trim().min(1).max(30),
  touch: z.coerce.number().gt(0).max(100),
});
export const updateKaratBody = karatBody.pick({ title: true, touch: true }).partial();
export interface KaratDto {
  id: number;
  metal: Metal;
  code: string;
  title: string;
  touch: string;
  isSystem: boolean;
}
/** Seeded per business on creation (justudhari defaults). */
export const DEFAULT_KARATS: ReadonlyArray<{ metal: Metal; code: string; title: string; touch: number }> = [
  { metal: 'GOLD', code: '24K', title: '24K', touch: 100 },
  { metal: 'GOLD', code: '22K', title: '22K', touch: 91.67 },
  { metal: 'GOLD', code: '20K', title: '20K', touch: 83.33 },
  { metal: 'GOLD', code: '18K', title: '18K', touch: 75 },
  { metal: 'SILVER', code: '999', title: '999', touch: 100 },
  { metal: 'SILVER', code: '925', title: '925', touch: 92.5 },
  { metal: 'SILVER', code: '800', title: '800', touch: 80 },
];

// ───────────── Metal rates & limits ─────────────

export const RATE_UNITS = ['GRAM_1', 'GRAM_10', 'TOLA', 'KG_1'] as const;
export type RateUnitKey = (typeof RATE_UNITS)[number];
/** grams in one rate unit (Nepali tola = 11.6638 g) */
export const RATE_UNIT_GRAMS: Record<RateUnitKey, number> = { GRAM_1: 1, GRAM_10: 10, TOLA: 11.6638, KG_1: 1000 };

export const setRatesBody = z.object({
  metal: z.enum(METALS),
  rateUnit: z.enum(RATE_UNITS),
  /** omit = business-wide; branch override only for admins */
  branchId: id.optional(),
  rates: z
    .array(z.object({ karatCode: z.string(), sellRate: decimalInput, buyRate: decimalInput }))
    .min(1),
  /** bypass RateLimit check (requires X-MPIN) */
  overrideLimits: z.boolean().default(false),
});
/** POST /app/rates/batch — several metals' rates saved in ONE transaction (all or nothing). Each entry = a POST /app/rates body
 *  (same rate-limit check; any entry with overrideLimits needs X-MPIN). One entry per metal + branch. */
export const setRatesBatchBody = z.object({
  metals: z
    .array(setRatesBody)
    .min(1)
    .max(8)
    .refine((ms) => new Set(ms.map((m) => `${m.metal}:${m.branchId ?? 0}`)).size === ms.length, 'Each metal may appear only once per branch'),
});
export interface RateRowDto {
  karatCode: string;
  title: string;
  touch: string;
  sellRate: string;
  buyRate: string;
  /** additive: this karat's sell rate in the save before the current one (same branch), re-expressed in the current rateUnit; null = no earlier rate. Trend arrow only. */
  prevSellRate?: string | null;
}
export interface CurrentRatesDto {
  /** effective scope of the returned rates */
  branchId: number | null;
  gold: { rateUnit: RateUnitKey; updatedAt: string | null; rows: RateRowDto[] };
  silver: { rateUnit: RateUnitKey; updatedAt: string | null; rows: RateRowDto[] };
  /** additive: the 'rates.display' setting, so the rate card can read it without settings.misc view */
  display?: { showBuy: boolean };
}
export const rateHistoryQuery = pageQuery.extend({ metal: z.enum(METALS).optional() });
export interface RateHistoryDto {
  id: number;
  metal: Metal;
  karatCode: string;
  rateUnit: RateUnitKey;
  sellRate: string;
  buyRate: string;
  effectiveAt: string;
  branchId: number;
  createdBy: string | null;
}

export const rateLimitsBody = z.object({
  limits: z
    .array(
      z
        .object({ metal: z.enum(METALS), rateUnit: z.enum(RATE_UNITS), minRate: decimalInput, maxRate: decimalInput })
        .refine((l) => l.maxRate > l.minRate, 'maxRate must be greater than minRate'),
    )
    .min(1),
});
export interface RateLimitDto {
  metal: Metal;
  rateUnit: RateUnitKey;
  minRate: string;
  maxRate: string;
}

// ───────────── Settings (key → value schema) ─────────────

const calcBasis = z.enum(['NET', 'GROSS', 'FINE']);
const numbering = z.object({
  format: z.enum(['NUMERIC', 'PREFIX', 'FY_PREFIX']).default('NUMERIC'),
  delimiter: z.enum(['/', '-', '.']).default('/'),
  padding: z.number().int().min(3).max(6).default(5),
  fyFormat: z.enum(['FULL', 'SHORT', 'YEAR']).default('FULL'),
  gstPrefix: z.string().max(10).default(''),
  gstStart: z.number().int().min(1).default(1),
  roughPrefix: z.string().max(10).default(''),
  roughStart: z.number().int().min(1).default(1),
  /** GST on (subtotal − metal received) instead of full subtotal */
  gstOnRemainingMetal: z.boolean().default(false),
});

/** TASK-84: item columns the printed invoice can show (empty list in invoice.content.columns = all). */
export const INVOICE_PRINT_COLUMNS = [
  'hsn', 'karat', 'pcs', 'gross', 'less', 'net', 'tunch', 'wastage', 'fine', 'stone', 'rate', 'labour', 'other', 'disc', 'total',
] as const;

/** task99: optional (show/hide) columns of the bill entry grid (BillForm OPTIONAL_COLS keys; Item/Gross/Total are fixed). */
export const BILL_GRID_COLUMNS = [
  'hsn', 'karat', 'pcs', 'less', 'tunch', 'wastage', 'net', 'fine', 'stone', 'rate', 'labour', 'unit', 'other', 'disc',
  // purchase-only columns (original Supp item / Supp tag / Remark / HUID / RFID)
  'suppItem', 'suppTag', 'remark', 'huid', 'rfid',
] as const;
export type BillGridColumn = (typeof BILL_GRID_COLUMNS)[number];
/** task99: Day Book Settings page sizes. */
export const DAYBOOK_PAGE_SIZES = [10, 20, 50, 100] as const;

/** TASK-98: printed bill formats (billing.invoice.format). A4_GST = the standard tax invoice. */
export const INVOICE_FORMATS = ['A4_GST', 'A4_ESTIMATE', 'A5', 'THERMAL_80', 'THERMAL_58', 'A4_IMAGES', 'A6'] as const;
export type InvoiceFormat = (typeof INVOICE_FORMATS)[number];

/** Every allowed setting key with its value schema. Value defaults = shop defaults when no row exists. */
export const SETTING_SCHEMAS = {
  'calc.basis': z.object({ sale: calcBasis.default('NET'), purchase: calcBasis.default('NET') }),
  'calc.amountBasedRate': z.object({ enabled: z.boolean().default(false) }),
  /** Dashboard rate card display (presentation only): show the Buy column */
  'rates.display': z.object({ showBuy: z.boolean().default(true) }),
  'rates.units': z.object({
    gold: z.enum(['GRAM_1', 'GRAM_10', 'TOLA']).default('GRAM_10'),
    silver: z.enum(['GRAM_1', 'KG_1']).default('KG_1'),
  }),
  'print.defaults': z.object({
    layout: z.enum(['THERMAL_80', 'A5', 'A4']).default('A4'),
    copies: z.number().int().min(1).max(5).default(1),
    autoWhatsappOnPrint: z.boolean().default(false),
    postSaveShareDialog: z.boolean().default(true),
  }),
  'invoice.sale': numbering,
  'invoice.purchase': numbering,
  'invoice.content': z.object({
    format: z.enum(['CLASSIC', 'PROFESSIONAL', 'PREMIUM_DARK', 'CLASSIC_BOXY', 'LETTERHEAD', 'LETTERHEAD_2']).default('CLASSIC'),
    terms: z.string().max(2000).default(''),
    justBillDisclaimer: z.string().max(1000).default(''),
    columns: z.array(z.enum(INVOICE_PRINT_COLUMNS)).default([]),
    /** TASK-84: watermark image opacity, percent */
    watermarkOpacity: z.number().int().min(0).max(100).default(10),
  }),
  /** TASK-84: uploaded invoice media (relative paths). Written ONLY by the upload endpoints — kept out of
   *  invoice.content so saving the content form can never wipe an uploaded logo. */
  'invoice.media': z.object({
    logoUrl: z.string().nullable().default(null),
    signatureUrl: z.string().nullable().default(null),
    watermarkUrl: z.string().nullable().default(null),
  }),
  /** Girvi defaults (docs/modules/06 §6.7) — prefilled on New Girvi, editable per loan */
  'girvi.defaults': z.object({
    ratePercent: z.number().min(0).max(100).default(2),
    ratePeriod: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
    interestType: z.enum(['SI', 'CI']).default('SI'),
    ciPeriod: z.enum(['DAILY', 'MONTHLY', 'HALF_YEARLY', 'YEARLY']).default('MONTHLY'),
    method: z.enum(['FULL_MONTH', 'DAY_WISE']).default('DAY_WISE'),
    /** loan = stdPercent % of valuation by default */
    stdPercent: z.number().min(1).max(100).default(60),
    tenureMonths: z.number().int().min(1).max(120).default(12),
    /** owner-approved: penalty % per month after the return date (0 = off) */
    penaltyRatePercent: z.number().min(0).max(100).default(0),
    categories: z.array(z.string().trim().min(1).max(40)).default(['Gold', 'Silver']),
    /** categories kept for old loans but hidden on New Girvi (Manage Item Categories: Activate/Deactivate) */
    inactiveCategories: z.array(z.string().trim().min(1).max(40)).default([]),
    /** show the "default N% of valuation" hint on New Girvi (missing = true) */
    showStdPercent: z.boolean().optional(),
  }),
  /** Girvi receipt layout (original: Receipt Customization & Layout Preview) — presentation only */
  'girvi.receipt': z.object({
    format: z.enum(['A4', 'THERMAL']).default('A4'),
    showShopName: z.boolean().default(true),
    showShopAddress: z.boolean().default(true),
    showShopMobile: z.boolean().default(true),
    showShopGst: z.boolean().default(true),
    showCustomerName: z.boolean().default(true),
    showCustomerMobile: z.boolean().default(true),
    showCustomerAddress: z.boolean().default(true),
    showCustomerPhoto: z.boolean().default(false),
    showGirviQr: z.boolean().default(true),
    showItemPhoto: z.boolean().default(false),
    showItemValuation: z.boolean().default(true),
    showItemWeights: z.boolean().default(true),
    showMonthlyInterest: z.boolean().default(true),
    showTotalInterest: z.boolean().default(true),
    showCalculations: z.boolean().default(true),
    showPaymentMode: z.boolean().default(true),
    showItemHistory: z.boolean().default(false),
    showRemarks: z.boolean().default(true),
    showSignatures: z.boolean().default(true),
    terms: z.string().max(1000).default(''),
  }),
  /** TASK-98: bill print format + what the printed sale/purchase bill shows — presentation only.
   *  Terms text stays in invoice.content.terms; amount-based rate stays in calc.amountBasedRate. */
  'billing.invoice': z.object({
    format: z.enum(INVOICE_FORMATS).default('A4_GST'),
    /** party's current udhar (money) balance under the bill totals */
    showDueBalance: z.boolean().default(false),
    showAmountInWords: z.boolean().default(true),
    showHsn: z.boolean().default(true),
    showSignature: z.boolean().default(true),
    showTerms: z.boolean().default(true),
    /** original: show_metal_payment_weight — METAL payment rows print gross/fine/rate, not only the ₹ amount */
    showMetalPaymentWeight: z.boolean().default(false),
  }),
  /** TASK-98 (original: metal_pay_rate_from_amount): on a metal payment row, type the ₹ amount and the rate is worked back as amount ÷ fine */
  'calc.metalPayRate': z.object({ fromAmount: z.boolean().default(false) }),
  /** TASK-98 Just Bill Preferences: which columns / pay rows New Just Bill + its print show (presentation only) */
  'justbill.prefs': z.object({
    showRate: z.boolean().default(true),
    showMaking: z.boolean().default(true),
    showGst: z.boolean().default(true),
    showOther: z.boolean().default(true),
    showAdvance: z.boolean().default(true),
    showReturn: z.boolean().default(true),
  }),
  /** G5 exchange defaults (owner 2026-10-30): round-off of the final MONEY amount only (weight / fine never), to `roundStep` rupees;
   *  and the base the difference % applies to. */
  'exchange.defaults': z.object({
    roundOff: z.enum(['NONE', 'NEAREST', 'UP', 'DOWN']).default('NONE'),
    roundStep: z.coerce.number().positive().max(1000).default(1),
    diffBy: z.enum(['WEIGHT', 'FINE']).default('FINE'),
  }),
  /** task99 Day Book Settings (/app/daybook/settings) — presentation only: which asset column groups the
   *  All-in-One / Summary show, the default source filter, the All-in-One page size, and the running-balance column. */
  'daybook.prefs': z.object({
    assets: z.array(z.enum(LEDGER_ASSETS)).default([...LEDGER_ASSETS]),
    /** null = all sources */
    defaultSource: z.enum(LEDGER_SOURCES).nullable().default(null),
    /** 20 = the All-in-One page size before this setting existed, so unsaved shops keep it */
    pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).default(20),
    showRunningBalance: z.boolean().default(true),
  }),
  /** task99 bill-grid visible optional columns per bill kind (replaces the per-browser 'ju.billcols').
   *  Missing kind = not saved yet (BillForm falls back to the browser copy, then all columns). */
  'billing.columns': z.object({
    sell: z.array(z.enum(BILL_GRID_COLUMNS)).optional(),
    purchase: z.array(z.enum(BILL_GRID_COLUMNS)).optional(),
  }),
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;
export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;
/** Resolved settings: branch row > business row > schema defaults. */
export type SettingsDto = { [K in SettingKey]: SettingValue<K> };

export const putSettingBody = z.object({
  /** omit = business-wide (owner/admin); set = branch override */
  branchId: id.optional(),
  value: z.unknown(),
});

// ── TASK-89: upcoming customer occasions (birthday / anniversary) ─────────────────────────
/** GET /app/parties/occasions?days=7 — occasions falling in the next `days` IST days (today included). */
export const occasionsQuery = z.object({ days: z.coerce.number().int().min(1).max(60).default(7) });
export interface OccasionDto {
  party: PartyRefDto;
  kind: 'BIRTHDAY' | 'ANNIVERSARY';
  /** this year's (or next year's) occurrence, 'YYYY-MM-DD' */
  date: string;
  /** 0 = today */
  daysAway: number;
}
