/**
 * Phase 11 — saving schemes + Anjuman (spec: docs/modules/08-schemes.md; routes: docs/api-phase11.md).
 * Scheme → Group → Enrollment → monthly SchemePayment. Balance lives on the enrollment (Σ payments) — no udhar
 * posting until redeem/withdraw, which credits the party (udhar −value). Maturity math: shared calc `schemeMaturity`.
 * GOLD scheme rates are in settings units (gold /10 g); fine bought per payment is stored at 3 dp.
 */
import { z } from 'zod';
import { id, pageQuery } from './common';
import { decimalInput } from './masters';
import type { PartyRefDto } from './masters';

export const SCHEME_KINDS = ['SAVING', 'ANJUMAN'] as const;
export const SCHEME_TYPES = ['CASH', 'GOLD'] as const;
export const SCHEME_BONUS_TYPES = ['NONE', 'ONE_EMI', 'PERCENT', 'FIXED'] as const;
export const ENROLLMENT_STATUSES = ['ACTIVE', 'WON', 'WITHDRAWN', 'CLOSED'] as const;
/** CASH/ONLINE/TOKEN/CHEQUE = money in (ledger SCHEME IN; ONLINE/CHEQUE into the chosen bank); DRAW/VENDOR = counted as paid, no money moved */
export const SCHEME_PAY_MEDIUMS = ['CASH', 'ONLINE', 'TOKEN', 'DRAW', 'VENDOR', 'CHEQUE'] as const;
/** media that need a bank account */
export const SCHEME_BANK_MEDIUMS: readonly string[] = ['ONLINE', 'CHEQUE'];

export const schemeBody = z
  .object({
    kind: z.enum(SCHEME_KINDS).default('SAVING'),
    type: z.enum(SCHEME_TYPES),
    name: z.string().trim().min(2).max(80),
    /** optional display title (Anjuman: Title + Scheme Name) */
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    /** 0 allowed for an ad-hoc Anjuman (no fixed EMI) */
    emiAmount: decimalInput,
    /** ≥1 for SAVING; an ANJUMAN with no EMI may send 0 / omit it (no installment slots, deposits are ad-hoc) */
    tenureMonths: z.coerce.number().int().min(0).max(120).default(0),
    bonusType: z.enum(SCHEME_BONUS_TYPES).default('NONE'),
    bonusValue: decimalInput.default(0),
    startDate: z.coerce.date(),
    validityDate: z.coerce.date().optional(),
  })
  .refine((b) => b.kind === 'ANJUMAN' || b.tenureMonths >= 1, { message: 'Tenure must be at least 1 month', path: ['tenureMonths'] })
  .refine((b) => (b.bonusType !== 'PERCENT' && b.bonusType !== 'FIXED') || b.bonusValue > 0, { message: 'Enter the bonus value', path: ['bonusValue'] })
  .refine((b) => b.bonusType !== 'ONE_EMI' || b.emiAmount > 0, { message: 'One-EMI bonus needs an EMI amount', path: ['bonusType'] });

/** PATCH /app/schemes/:id — rename / describe / validity / active toggle (amounts and bonus are fixed once members exist) */
export const schemePatchBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  /** null clears it */
  title: z.string().trim().min(1).max(80).nullable().optional(),
  description: z.string().trim().max(300).optional(),
  validityDate: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
});

export const schemeGroupBody = z.object({ schemeId: id, name: z.string().trim().min(1).max(60), memberLimit: z.coerce.number().int().min(1).optional() });

export const schemePaymentInput = z
  .object({
    /** default: lowest unpaid installment; ignored for TOKEN and for EMI-less schemes */
    emiNo: z.coerce.number().int().min(1).max(120).optional(),
    txnDate: z.coerce.date().optional(),
    amount: decimalInput.positive(),
    medium: z.enum(SCHEME_PAY_MEDIUMS).default('CASH'),
    bankAccountId: id.optional(),
    /** GOLD schemes: settings units; default = today's sell rate */
    rate: decimalInput.optional(),
    remark: z.string().trim().max(200).optional(),
  })
  .refine((p) => !SCHEME_BANK_MEDIUMS.includes(p.medium) || p.bankAccountId != null, { message: 'Select a bank account', path: ['bankAccountId'] });

export const enrollmentBody = z.object({
  schemeId: id,
  groupId: id.optional(),
  partyId: id,
  assignId: z.string().trim().toUpperCase().min(1).max(30),
  displayName: z.string().trim().min(1).max(80),
  /** default: the scheme's EMI */
  emiAmount: decimalInput.optional(),
  startDate: z.coerce.date().optional(),
  /** joining token (spec token_amt) → a TOKEN payment, counts toward paid */
  tokenAmount: decimalInput.default(0),
  /** how the token was paid; TOKEN (default) = cash-in as before. Never takes an EMI slot. ONLINE needs tokenBankAccountId. */
  tokenMedium: z.enum(SCHEME_PAY_MEDIUMS).optional(),
  tokenBankAccountId: id.optional(),
  /** "Enroll with EMI pay" */
  firstPayment: schemePaymentInput.optional(),
});

export const addSchemePaymentBody = schemePaymentInput.and(z.object({ enrollmentId: id }));

/** Lucky-draw winner (X-MPIN). The UI then records the remaining months as DRAW payments. */
export const enrollmentWonBody = z.object({ remark: z.string().trim().max(200).optional() });

/** Redeem a matured enrollment, or withdraw early (bonus 0). Credits the party (udhar −value); enrollment → CLOSED / WITHDRAWN. */
export const redeemBody = z.object({
  early: z.boolean().default(false),
  /** GOLD: settings units; default = today's sell rate */
  redeemRate: decimalInput.optional(),
  remark: z.string().trim().max(200).optional(),
});

export const schemeListQuery = pageQuery.extend({
  kind: z.enum(SCHEME_KINDS).optional(),
  type: z.enum(SCHEME_TYPES).optional(),
  active: z.enum(['true', 'false']).optional(),
  /** date range on `dateField` (default startDate); inclusive business days */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  dateField: z.enum(['startDate', 'createdAt']).optional(),
});
export const schemeGroupListQuery = z.object({ schemeId: id.optional() });
export const enrollmentListQuery = pageQuery.extend({
  kind: z.enum(SCHEME_KINDS).optional(),
  schemeId: id.optional(),
  groupId: id.optional(),
  partyId: id.optional(),
  /** one status, or a comma list (e.g. WON,WITHDRAWN) */
  status: z
    .preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.enum(ENROLLMENT_STATUSES)).min(1))
    .optional(),
  /** only ACTIVE/WON with an installment due on or before today */
  due: z.enum(['true', 'false']).optional(),
  /** enrol (start) date range, inclusive */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
/** GET /app/schemes/dues — perMonth=true returns SchemeDueMonthRowDto[] (one row per unpaid due EMI) */
export const schemeDuesQuery = z.object({
  kind: z.enum(SCHEME_KINDS).optional(),
  schemeId: id.optional(),
  groupId: id.optional(),
  /** assign id / member name / party name / mobile */
  q: z.string().trim().optional(),
  perMonth: z.enum(['true', 'false']).optional(),
});
export const schemeTxnListQuery = pageQuery.extend({
  kind: z.enum(SCHEME_KINDS).optional(),
  schemeId: id.optional(),
  groupId: id.optional(),
  /** one medium, or a comma list (e.g. CASH,TOKEN) */
  medium: z
    .preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.enum(SCHEME_PAY_MEDIUMS)).min(1))
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const schemeDayBookQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), kind: z.enum(SCHEME_KINDS).optional() });

export interface SchemeDto {
  id: number;
  kind: (typeof SCHEME_KINDS)[number];
  type: (typeof SCHEME_TYPES)[number];
  name: string;
  title?: string | null;
  description: string | null;
  emiAmount: string;
  tenureMonths: number;
  bonusType: (typeof SCHEME_BONUS_TYPES)[number];
  bonusValue: string;
  startDate: string;
  validityDate: string | null;
  isActive: boolean;
  branch: { id: number; name: string };
  memberCount: number;
  createdAt: string;
}

export interface SchemeGroupDto {
  id: number;
  schemeId: number;
  name: string;
  memberLimit: number | null;
  memberCount: number;
}

export interface SchemePaymentDto {
  id: number;
  enrollmentId: number;
  emiNo: number | null;
  emiDate: string | null;
  txnDate: string;
  amount: string;
  medium: (typeof SCHEME_PAY_MEDIUMS)[number];
  bankAccount: { id: number; name: string } | null;
  rate: string | null;
  fine: string | null;
  remark: string | null;
  isReversed: boolean;
  createdBy: string | null;
  createdAt: string;
}

/** shared calc `schemeMaturity` as of today (GOLD at today's rate) */
export interface SchemeMaturityDto {
  paid: string;
  fine: string;
  bonus: string;
  maturity: string;
  maturityValue: string;
}

export interface EnrollmentDto {
  id: number;
  scheme: { id: number; name: string; kind: (typeof SCHEME_KINDS)[number]; type: (typeof SCHEME_TYPES)[number]; tenureMonths: number };
  group: { id: number; name: string } | null;
  party: PartyRefDto;
  branch: { id: number; name: string };
  assignId: string;
  displayName: string;
  emiAmount: string;
  startDate: string;
  status: (typeof ENROLLMENT_STATUSES)[number];
  /** non-reversed installments (emiNo set) */
  emisPaid: number;
  /** installments due by today and unpaid */
  emisDue: number;
  /** emisPaid ≥ tenure */
  matured: boolean;
  nextEmiNo: number | null;
  nextEmiDate: string | null;
  maturity: SchemeMaturityDto;
  redeemValue: string | null;
  redeemFine: string | null;
  redeemRate: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface EnrollmentDetailDto extends EnrollmentDto {
  payments: SchemePaymentDto[];
}

/** GET /app/schemes/transactions row */
export interface SchemeTxnRowDto extends SchemePaymentDto {
  scheme: { id: number; name: string };
  group: { id: number; name: string } | null;
  party: PartyRefDto;
  assignId: string;
}

/** GET /app/schemes/dues row */
export interface SchemeDueRowDto {
  enrollmentId: number;
  assignId: string;
  displayName: string;
  party: PartyRefDto;
  scheme: { id: number; name: string };
  group: { id: number; name: string } | null;
  emiAmount: string;
  emisDue: number;
  dueAmount: string;
  oldestDueDate: string;
}

/** GET /app/schemes/dues?perMonth=true row — one unpaid installment that is due by today */
export interface SchemeDueMonthRowDto {
  enrollmentId: number;
  assignId: string;
  party: PartyRefDto;
  scheme: { id: number; name: string };
  group: { id: number; name: string } | null;
  emiNo: number;
  emiDate: string;
  amount: string;
}

/** One business day of the scheme day-book (SCHEME ledger rows on that date; reversals count on their own date) */
export interface SchemeDayBookDayDto {
  date: string;
  opening: string;
  moneyIn: string;
  moneyOut: string;
  closing: string;
  /** scheme payments dated that day */
  txnCount: number;
}

/** GET /app/schemes/day-book — money in/out from SCHEME ledger rows */
export interface SchemeDayBookDto {
  from: string;
  to: string;
  opening: string;
  moneyIn: string;
  moneyOut: string;
  closing: string;
  rows: SchemeTxnRowDto[];
  days?: SchemeDayBookDayDto[];
}
