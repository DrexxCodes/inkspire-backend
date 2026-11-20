import { ROLE_RANK } from "../../config/permissions.js";
import type { Role } from "../../types/domain.js";
import { forbidden } from "../../utils/errors.js";

interface Actor {
  uid: string;
  role: Role;
}
interface Target {
  id: string;
  role: Role;
}

/**
 * Who may act on whom. Applies to disabling, blocking, role and permission changes.
 * Nobody can act on themselves, and only a super admin can act on someone of equal or
 * higher rank.
 */
export function assertCanManageUser(actor: Actor, target: Target): void {
  if (actor.uid === target.id) {
    throw forbidden("CANNOT_MODIFY_SELF", "You cannot perform this action on your own account.");
  }
  if (actor.role !== "super_admin" && ROLE_RANK[target.role] >= ROLE_RANK[actor.role]) {
    throw forbidden("TARGET_OUTRANKS_ACTOR", "You cannot manage an account with an equal or higher role.");
  }
}

/** An actor may only hand out roles below their own, unless they are a super admin. */
export function assertCanAssignRole(actor: Actor, newRole: Role): void {
  if (actor.role !== "super_admin" && ROLE_RANK[newRole] >= ROLE_RANK[actor.role]) {
    throw forbidden("ROLE_NOT_ASSIGNABLE", "You cannot assign a role equal to or higher than your own.");
  }
}
