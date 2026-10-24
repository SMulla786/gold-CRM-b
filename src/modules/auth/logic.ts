// Pure auth helpers (no env / no Prisma) so they unit-test without a DB or secrets.
import { MODULES, PAGE_KEYS } from '../../shared';
import type { MeDto, PermissionMap } from '../../shared';

/** Module keys that are always on regardless of plan (dashboard, settings). */
export const CORE_MODULES = MODULES.filter((m) => m.core).map((m) => m.key);

/** Admins and super admins get every page action. */
export const ALL_PERMISSIONS: PermissionMap = Object.fromEntries(
  PAGE_KEYS.map((k) => [k, { view: true, edit: true, delete: true }]),
);

export interface PermRow {
  key: string;
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/** Role defaults overlaid with per-user overrides (an override row replaces the role value). */
export function buildPermissionMap(rolePerms: PermRow[], overrides: PermRow[]): PermissionMap {
  const map: PermissionMap = {};
  for (const r of [...rolePerms, ...overrides]) {
    map[r.key] = { view: r.canView, edit: r.canEdit, delete: r.canDelete };
  }
  return map;
}

/** Subtree test on the materialised path, e.g. inSubtree('/1/4/9/', '/1/4/') === true. */
export const inSubtree = (branchPath: string, rootPath: string): boolean => branchPath.startsWith(rootPath);

/** Modules + subscription summary for MeDto. active=false (expired/suspended/none) ⇒ read-only, core modules only. */
export function resolveAccess(
  active: boolean,
  displaySub: { planName: string; endsAt: Date; modules: string[] } | null,
): { modules: string[]; subscription: MeDto['subscription'] } {
  const readOnly = !active;
  const modules = Array.from(new Set([...CORE_MODULES, ...(active && displaySub ? displaySub.modules : [])]));
  return {
    modules,
    subscription: displaySub ? { planName: displaySub.planName, endsAt: displaySub.endsAt.toISOString(), readOnly } : null,
  };
}
