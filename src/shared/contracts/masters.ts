/**
 * Phase 1 — masters & settings contracts (spec: docs/modules/11-masters-settings.md, routes: docs/api-phase1.md).
 * Decimals in responses are strings; inputs accept number or numeric string.
 */
import { z } from 'zod';
import { gstin, id, mobile, pageQuery } from './common';

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
export interface RateRowDto {
  karatCode: string;
  title: string;
  touch: string;
  sellRate: string;
  buyRate: string;
}
export interface CurrentRatesDto {
  /** effective scope of the returned rates */
  branchId: number | null;
  gold: { rateUnit: RateUnitKey; updatedAt: string | null; rows: RateRowDto[] };
  silver: { rateUnit: RateUnitKey; updatedAt: string | null; rows: RateRowDto[] };
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

/** Every allowed setting key with its value schema. Value defaults = shop defaults when no row exists. */
export const SETTING_SCHEMAS = {
  'calc.basis': z.object({ sale: calcBasis.default('NET'), purchase: calcBasis.default('NET') }),
  'calc.amountBasedRate': z.object({ enabled: z.boolean().default(false) }),
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
    columns: z.array(z.string()).default([]),
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
    categories: z.array(z.string().trim().min(1).max(40)).default(['Gold', 'Silver']),
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
