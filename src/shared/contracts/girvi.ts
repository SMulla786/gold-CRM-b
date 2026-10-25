/**
 * Phase 9 — girvi (pledge loans) (spec: docs/modules/06-girvi.md; routes: docs/api-phase9.md).
 * Interest = shared calc `girviInterest` on the outstanding principal from `interestFrom` to the as-of date.
 */
import { z } from 'zod';
import { id, pageQuery } from './common';
import { decimalInput } from './masters';
import type { PartyRefDto } from './masters';

const weight = z.coerce.number().finite().min(0).max(1_000_000);
const money = { cash: decimalInput.default(0), online: decimalInput.default(0), bankAccountId: id.optional() };
const bankRule = <T extends { online: number; bankAccountId?: number }>(b: T) => b.online === 0 || b.bankAccountId != null;

export const girviItemInput = z.object({
  category: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  gross: weight.positive(),
  net: weight.positive(),
  /** purity % */
  purity: z.coerce.number().min(0).max(100),
  /** valuation rate per gram of fine */
  rate: decimalInput,
});

export const girviBody = z
  .object({
    partyId: id,
    issueDate: z.coerce.date().optional(),
    items: z.array(girviItemInput).min(1).max(30),
    /** loan granted; defaults client-side to stdPercent of valuation */
    principal: decimalInput.positive(),
    ratePercent: z.coerce.number().min(0).max(100),
    ratePeriod: z.enum(['MONTHLY', 'ANNUAL']),
    interestType: z.enum(['SI', 'CI']),
    ciPeriod: z.enum(['DAILY', 'MONTHLY', 'HALF_YEARLY', 'YEARLY']).optional(),
    method: z.enum(['FULL_MONTH', 'DAY_WISE']),
    tenureMonths: z.coerce.number().int().min(1).max(120),
    remark: z.string().trim().max(300).optional(),
    /** how the loan is paid out: cash + online must equal principal */
    ...money,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] })
  .refine((b) => Math.abs(b.cash + b.online - b.principal) < 0.005, { message: 'Cash + online must equal the loan amount', path: ['cash'] })
  .refine((b) => b.interestType === 'SI' || b.ciPeriod != null, { message: 'Pick the compounding period', path: ['ciPeriod'] });

/** Pay interest only (up to the as-of date; partial allowed — interestFrom moves forward only when fully paid up). */
export const girviInterestBody = z
  .object({ txnDate: z.coerce.date().optional(), interest: decimalInput.positive(), discount: decimalInput.default(0), remark: z.string().trim().max(200).optional(), ...money })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] });

/** Extra loan on the same batch. */
export const girviTopupBody = z
  .object({ txnDate: z.coerce.date().optional(), principal: decimalInput.positive(), remark: z.string().trim().max(200).optional(), ...money })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] });

/** Release items: settle interest due + repay principal (all items → batch CLOSED, principal must reach 0). */
export const girviReleaseBody = z
  .object({
    txnDate: z.coerce.date().optional(),
    itemIds: z.array(id).min(1),
    principalPaid: decimalInput.default(0),
    interestPaid: decimalInput.default(0),
    discount: decimalInput.default(0),
    remark: z.string().trim().max(200).optional(),
    ...money,
  })
  .refine(bankRule, { message: 'Select a bank account', path: ['bankAccountId'] });

export const girviListQuery = pageQuery.extend({ status: z.enum(['ACTIVE', 'CLOSED']).optional(), partyId: id.optional() });
export const girviAsOfQuery = z.object({ asOf: z.coerce.date().optional() });

export interface GirviItemDto {
  id: number;
  category: string;
  name: string;
  photoUrl: string | null;
  gross: string;
  net: string;
  purity: string;
  fine: string;
  rate: string;
  valuation: string;
  status: 'PLEDGED' | 'RELEASED';
  releasedAt: string | null;
}

export interface GirviTxnDto {
  id: number;
  type: 'GRANT' | 'TOPUP' | 'INTEREST' | 'RELEASE';
  txnDate: string;
  principal: string;
  interest: string;
  discount: string;
  cash: string;
  online: string;
  bankAccount: { id: number; name: string } | null;
  itemIds: number[];
  remark: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface GirviBatchDto {
  id: number;
  girviNo: number;
  party: PartyRefDto;
  branch: { id: number; name: string };
  issueDate: string;
  returnDate: string;
  tenureMonths: number;
  ratePercent: string;
  ratePeriod: 'MONTHLY' | 'ANNUAL';
  interestType: 'SI' | 'CI';
  ciPeriod: 'DAILY' | 'MONTHLY' | 'HALF_YEARLY' | 'YEARLY' | null;
  method: 'FULL_MONTH' | 'DAY_WISE';
  valuation: string;
  principal: string;
  interestFrom: string;
  /** as of the query date (default today) */
  interestDue: string;
  /** principal + interestDue */
  payable: string;
  overdue: boolean;
  status: 'ACTIVE' | 'CLOSED';
  remark: string | null;
  items: GirviItemDto[];
  txns: GirviTxnDto[];
  createdAt: string;
}

export interface GirviListItemDto {
  id: number;
  girviNo: number;
  party: PartyRefDto;
  issueDate: string;
  returnDate: string;
  itemCount: number;
  pledgedCount: number;
  valuation: string;
  principal: string;
  interestDue: string;
  overdue: boolean;
  status: 'ACTIVE' | 'CLOSED';
}
