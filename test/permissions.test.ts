import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_KEYS,
  ROLE_DEFAULTS,
  hasAnyPermission,
  resolvePermissions,
} from "../src/config/permissions.js";
import { assertCanAssignRole, assertCanManageUser } from "../src/modules/admin/admin.rules.js";
import { AppError } from "../src/utils/errors.js";

const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.code === code);

test("a plain user holds no permissions", () => {
  const p = resolvePermissions("user");
  assert.equal(hasAnyPermission(p), false);
});

test("a moderator can moderate and view analytics but not delete or manage the platform", () => {
  const p = resolvePermissions("moderator");
  assert.equal(p.moderateWorks, true);
  assert.equal(p.viewAnalytics, true);
  assert.equal(p.deleteWorks, false);
  assert.equal(p.managePlatform, false);
});

test("super admin always holds every permission, whatever the overrides say", () => {
  const p = resolvePermissions("super_admin", { managePlatform: false });
  for (const key of PERMISSION_KEYS) assert.equal(p[key], true);
});

test("overrides adjust a role's defaults per user", () => {
  const p = resolvePermissions("moderator", { manageCategories: true, moderateWorks: false });
  assert.equal(p.manageCategories, true);
  assert.equal(p.moderateWorks, false);
});

test("non boolean override values are ignored (never trust stored junk)", () => {
  const p = resolvePermissions("user", { manageUsers: "true", managePlatform: 1 });
  assert.equal(p.manageUsers, false);
  assert.equal(p.managePlatform, false);
});

test("a client supplied role string has no effect on resolved permissions", () => {
  // Permissions come from the stored role. Unknown roles fall back to the least privilege set.
  const p = resolvePermissions("admin" as never, null);
  assert.deepEqual(p, ROLE_DEFAULTS.admin);
  const unknown = resolvePermissions("root" as never, null);
  assert.deepEqual(unknown, ROLE_DEFAULTS.user);
});

test("permanent deletion and role management are reserved for super admins by default", () => {
  assert.equal(ROLE_DEFAULTS.admin.permanentlyDeleteWorks, false);
  assert.equal(ROLE_DEFAULTS.admin.manageRoles, false);
  assert.equal(ROLE_DEFAULTS.super_admin.permanentlyDeleteWorks, true);
});

test("nobody can manage their own account", () => {
  throwsCode(
    () => assertCanManageUser({ uid: "a", role: "super_admin" }, { id: "a", role: "super_admin" }),
    "CANNOT_MODIFY_SELF",
  );
});

test("an admin cannot manage peers or superiors, but can manage moderators and users", () => {
  const admin = { uid: "a", role: "admin" as const };
  throwsCode(() => assertCanManageUser(admin, { id: "b", role: "admin" }), "TARGET_OUTRANKS_ACTOR");
  throwsCode(() => assertCanManageUser(admin, { id: "b", role: "super_admin" }), "TARGET_OUTRANKS_ACTOR");
  assert.doesNotThrow(() => assertCanManageUser(admin, { id: "b", role: "moderator" }));
  assert.doesNotThrow(() => assertCanManageUser(admin, { id: "b", role: "user" }));
});

test("a super admin can manage other admins", () => {
  assert.doesNotThrow(() => assertCanManageUser({ uid: "a", role: "super_admin" }, { id: "b", role: "admin" }));
});

test("role assignment is capped below the actor's own rank unless super admin", () => {
  throwsCode(() => assertCanAssignRole({ uid: "a", role: "admin" }, "admin"), "ROLE_NOT_ASSIGNABLE");
  throwsCode(() => assertCanAssignRole({ uid: "a", role: "admin" }, "super_admin"), "ROLE_NOT_ASSIGNABLE");
  assert.doesNotThrow(() => assertCanAssignRole({ uid: "a", role: "admin" }, "moderator"));
  assert.doesNotThrow(() => assertCanAssignRole({ uid: "a", role: "super_admin" }, "super_admin"));
});

test("managePrompts belongs to admins and super admins only", () => {
  assert.equal(resolvePermissions("admin").managePrompts, true);
  assert.equal(resolvePermissions("super_admin").managePrompts, true);
  assert.equal(resolvePermissions("user").managePrompts, false);
  assert.equal(resolvePermissions("moderator").managePrompts, false);
});

test("a per user override cannot give a moderator or user the managePrompts power", () => {
  assert.equal(resolvePermissions("moderator", { managePrompts: true }).managePrompts, false);
  assert.equal(resolvePermissions("user", { managePrompts: true }).managePrompts, false);
});

test("an admin can have managePrompts switched off by override", () => {
  assert.equal(resolvePermissions("admin", { managePrompts: false }).managePrompts, false);
});
