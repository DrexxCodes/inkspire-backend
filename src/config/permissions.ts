import type { Role } from "../types/domain.js";

export const PERMISSION_KEYS = [
  "manageUsers",
  "manageRoles",
  "manageCategories",
  "moderateWorks",
  "deleteWorks",
  "permanentlyDeleteWorks",
  "viewAnalytics",
  "managePlatform",
  "managePrompts",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionMap = Record<PermissionKey, boolean>;

const build = (value: boolean): PermissionMap =>
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, value])) as PermissionMap;

/** Default permission matrix per role. Individual users can carry overrides. */
export const ROLE_DEFAULTS: Record<Role, PermissionMap> = {
  user: build(false),
  moderator: { ...build(false), moderateWorks: true, viewAnalytics: true },
  admin: { ...build(true), manageRoles: false, permanentlyDeleteWorks: false },
  super_admin: build(true),
};

export const ROLE_RANK: Record<Role, number> = {
  user: 0,
  moderator: 1,
  admin: 2,
  super_admin: 3,
};

export const ROLES = Object.keys(ROLE_RANK) as Role[];

/** Powers that only an admin or a super admin can ever hold. A per user override cannot lift a lower role into them. */
export const ADMIN_ONLY_PERMISSIONS: readonly PermissionKey[] = ["managePrompts"];

export function resolvePermissions(
  role: Role,
  overrides?: Partial<Record<string, unknown>> | null,
): PermissionMap {
  if (role === "super_admin") return build(true);
  const result = { ...(ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.user) };
  if (overrides) {
    for (const key of PERMISSION_KEYS) {
      if (typeof overrides[key] === "boolean") result[key] = overrides[key] as boolean;
    }
  }
  if (ROLE_RANK[role] < ROLE_RANK.admin) {
    for (const key of ADMIN_ONLY_PERMISSIONS) result[key] = false;
  }
  return result;
}

export const hasAnyPermission = (p: PermissionMap) => Object.values(p).some(Boolean);
