import { z } from 'zod';
import type { UserLevel } from '../enums';
import type { PermissionAction } from '../permissions';
import { mpin, password } from './common';

/** Refresh token cookie: httpOnly, sameSite=lax, path=/api/auth, rotated on every refresh. */
export const REFRESH_COOKIE = 'ju_rt';

export const loginBody = z.object({
  /** username or email */
  login: z.string().trim().min(3),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBody>;

export const setMpinBody = z.object({ password: z.string().min(1), mpin });
export const verifyMpinBody = z.object({ mpin });
export const changePasswordBody = z.object({ current: z.string().min(1), next: password });
export const forgotPasswordBody = z.object({ login: z.string().trim().min(3) });
export const resetPasswordBody = z.object({ login: z.string().trim().min(3), otp: z.string().regex(/^\d{6}$/), next: password });

export interface BranchRef {
  id: number;
  name: string;
  parentId: number | null;
  path: string;
  depth: number;
  isAdminNode: boolean;
}

export type PermissionMap = Record<string, Partial<Record<PermissionAction, boolean>>>;

export interface MeDto {
  id: number;
  name: string;
  username: string;
  level: UserLevel;
  isOwner: boolean;
  business: { id: number; name: string; status: 'ACTIVE' | 'SUSPENDED' } | null;
  /** Node the user is attached to (admins: root of their subtree). */
  branch: BranchRef | null;
  /** Every branch the user may act in (admins: whole subtree; branch users: own + extra). */
  accessibleBranches: BranchRef[];
  /** Effective page permissions (admins/super admin: everything true). */
  permissions: PermissionMap;
  /** Module keys enabled by the current subscription. */
  modules: string[];
  /** adEligible: the business's CURRENT term is ad-supported (a snapshot of the plan when the term was made) and the
   *  business is active. Never derived from price; paid / trial / expired / suspended / queued terms → false. */
  subscription: { planName: string; endsAt: string; readOnly: boolean; adEligible: boolean } | null;
  hasMpin: boolean;
  impersonatedBy: { id: number; name: string } | null;
}

export interface LoginResponse {
  accessToken: string;
  user: MeDto;
}
export interface RefreshResponse {
  accessToken: string;
}
