import { z } from 'zod';

/** Error body for every non-2xx response. */
export const ERROR_CODES = [
  'VALIDATION', // 400
  'INVALID_CREDENTIALS', // 401 (same message for unknown user / wrong password)
  'UNAUTHENTICATED', // 401 missing/expired access token
  'ACCOUNT_BLOCKED', // 403
  'FORBIDDEN', // 403 permission missing
  'READ_ONLY', // 403 subscription expired / suspended → writes blocked
  'MODULE_DISABLED', // 403 module not in plan
  'PLAN_LIMIT', // 403 branch/user limit reached
  'MPIN_REQUIRED', // 403 sensitive action without valid X-MPIN header
  'DAY_CLOSED', // 403 posting onto a branch-day that has been closed in the Day-Book (TASK-80)
  'NOT_FOUND', // 404 also used for rows outside caller's tenant/subtree
  'CONFLICT', // 409 unique violations
  'INTERNAL', // 500
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const mobile = z.string().trim().regex(/^\d{10}$/, '10-digit mobile number');
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, '3-40 chars: a-z 0-9 . _ -');
export const password = z.string().min(8, 'At least 8 characters').max(100);
export const mpin = z.string().regex(/^\d{4}$/, '4 digits');
export const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');
export const id = z.coerce.number().int().positive();

/** Request headers understood by the API. */
export const HEADERS = {
  /** Active branch context for admins: a branch id inside the caller's subtree, or "all". Branch users: ignored. */
  BRANCH: 'X-Branch-Id',
  /** 4-digit MPIN for sensitive actions (deletes, settings saves, set stock). */
  MPIN: 'X-MPIN',
} as const;
