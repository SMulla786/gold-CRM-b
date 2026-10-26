/**
 * TASK-98 — Samples / Tounch register. A physical-custody register only: nothing here posts to the ledger
 * (a melt is posted through kacha processing). Weights are 3-dp strings in responses.
 * Lifecycle: IN_HAND → ISSUED (issue) → RETURNED (return) → ISSUED …; any non-MELTED → MELTED (terminal).
 */
import { z } from 'zod';
import { id, pageQuery } from './common';
import { METALS } from './masters';
import type { Metal } from './masters';

export const SAMPLE_STATUSES = ['IN_HAND', 'ISSUED', 'RETURNED', 'MELTED'] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];
export const SAMPLE_ACTIONS = ['CREATED', 'ISSUED', 'RETURNED', 'MELTED', 'EDITED'] as const;
export type SampleAction = (typeof SAMPLE_ACTIONS)[number];

const weight = z.coerce.number().finite().min(0).max(1_000_000);
const note = z.string().trim().max(300);

export const sampleBody = z.object({
  metal: z.enum(METALS),
  grossWt: weight.positive(),
  tounchPercent: z.coerce.number().finite().min(0).max(100),
  /** omitted → grossWt × tounchPercent / 100 (3 dp, half-up) */
  fine: weight.optional(),
  partyId: id.optional(),
  /** must be a KARIGAR party */
  karigarId: id.optional(),
  note: note.optional(),
});

/** Edit while IN_HAND or RETURNED. null clears party/karigar/note. Changing grossWt/tounch without fine recomputes fine. */
export const updateSampleBody = z.object({
  metal: z.enum(METALS).optional(),
  grossWt: weight.positive().optional(),
  tounchPercent: z.coerce.number().finite().min(0).max(100).optional(),
  fine: weight.optional(),
  partyId: id.nullable().optional(),
  karigarId: id.nullable().optional(),
  note: note.nullable().optional(),
});

/** POST /samples/:id/issue — who it goes to (both optional; given values replace the sample's party/karigar). */
export const sampleIssueBody = z.object({ karigarId: id.optional(), partyId: id.optional(), note: note.optional() });
/** POST /samples/:id/return and /melt */
export const sampleNoteBody = z.object({ note: note.optional() });

export const sampleListQuery = pageQuery.extend({
  status: z.enum(SAMPLE_STATUSES).optional(),
  metal: z.enum(METALS).optional(),
  partyId: id.optional(),
  karigarId: id.optional(),
});

/** GET /samples/search — light picker list; default statuses IN_HAND + RETURNED. */
export const sampleSearchQuery = z.object({
  q: z.string().trim().optional(),
  metal: z.enum(METALS).optional(),
  /** comma list of SAMPLE_STATUSES (default "IN_HAND,RETURNED") */
  statuses: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(SAMPLE_STATUSES)).optional()),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface SampleDto {
  id: number;
  sampleNo: number;
  metal: Metal;
  grossWt: string;
  tounchPercent: string;
  fine: string;
  status: SampleStatus;
  note: string | null;
  party: { id: number; name: string } | null;
  karigar: { id: number; name: string } | null;
  branch: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface SampleMovementDto {
  id: number;
  action: SampleAction;
  party: { id: number; name: string } | null;
  karigar: { id: number; name: string } | null;
  note: string | null;
  user: string | null;
  createdAt: string;
}

export interface SampleDetailDto extends SampleDto {
  movements: SampleMovementDto[];
}

/** GET /samples/search row */
export interface SamplePickDto {
  id: number;
  sampleNo: number;
  metal: Metal;
  grossWt: string;
  tounchPercent: string;
  fine: string;
  status: SampleStatus;
  party: { id: number; name: string } | null;
  karigar: { id: number; name: string } | null;
}
