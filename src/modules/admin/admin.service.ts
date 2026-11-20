import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, db } from "../../config/firebase.js";
import { env } from "../../config/env.js";
import { query } from "../../config/postgres.js";
import { PERMISSION_KEYS, ROLES, resolvePermissions } from "../../config/permissions.js";
import type { AccountStatus, AuthContext, Role, UserDoc } from "../../types/domain.js";
import { getUserById, usersCol, toPublicProfile } from "../../repositories/users.repo.js";
import { getCategory } from "../../repositories/categories.repo.js";
import { getWork, workRef, worksCol, hydrateWorks } from "../../repositories/works.repo.js";
import { logAdmin, type AdminAction } from "../../services/audit.service.js";
import { invalidateProfile } from "../../services/profile-cache.service.js";
import { deletePrefix } from "../../services/storage.service.js";
import { AppError, badRequest, conflict, notFound, unavailable } from "../../utils/errors.js";
import { clampLimit, docId, runPage } from "../../utils/pagination.js";
import { serialize } from "../../utils/serialize.js";
import type { Doc } from "../../types/domain.js";
import { assertCanAssignRole, assertCanManageUser } from "./admin.rules.js";

type Logger = Parameters<typeof logAdmin>[1];

export const roleSchema = z.object({ role: z.enum(ROLES as [Role, ...Role[]]) });
export const permissionsSchema = z.object({
  permissions: z.object(Object.fromEntries(PERMISSION_KEYS.map((k) => [k, z.boolean().optional()]))).strict(),
});
export const statusSchema = z.object({ reason: z.string().trim().max(500).optional() });

async function loadTarget(uid: string): Promise<UserDoc> {
  const user = await getUserById(uid);
  if (!user) throw notFound("USER_NOT_FOUND", "That user does not exist.");
  return user;
}

export function toAdminUserDto(u: UserDoc) {
  return serialize({
    id: u.id,
    ...toPublicProfile(u),
    email: u.email ?? null,
    role: u.role,
    permissions: resolvePermissions(u.role, u.permissions),
    permissionOverrides: u.permissions ?? {},
    accountStatus: u.accountStatus,
    statusReason: u.statusReason ?? null,
    updatedAt: u.updatedAt,
  });
}

/* ---------------------------------- Users list ---------------------------------- */

export async function searchUsers(params: { q?: string; role?: string; status?: string; cursor?: string; limit?: string }) {
  let q: FirebaseFirestore.Query = usersCol();
  const term = params.q?.trim().toLowerCase();

  if (term?.includes("@")) {
    q = q.where("email", "==", term).limit(1);
    const snap = await q.get();
    return { items: snap.docs.map((d) => toAdminUserDto({ id: d.id, ...d.data() } as UserDoc)), nextCursor: null };
  }
  if (params.role) q = q.where("role", "==", params.role);
  if (params.status) q = q.where("accountStatus", "==", params.status);
  if (term) {
    q = q.where("usernameLower", ">=", term).where("usernameLower", "<", `${term}`).orderBy("usernameLower").orderBy(docId());
    const { docs, nextCursor } = await runPage(q, {
      limit: clampLimit(params.limit, 20, 50),
      cursor: params.cursor,
      cursorFields: (d) => [d.get("usernameLower"), d.id],
    });
    return { items: docs.map((d) => toAdminUserDto({ id: d.id, ...d.data() } as UserDoc)), nextCursor };
  }
  q = q.orderBy("createdAt", "desc").orderBy(docId(), "desc");
  const { docs, nextCursor } = await runPage(q, {
    limit: clampLimit(params.limit, 20, 50),
    cursor: params.cursor,
    cursorFields: (d) => [d.get("createdAt"), d.id],
  });
  return { items: docs.map((d) => toAdminUserDto({ id: d.id, ...d.data() } as UserDoc)), nextCursor };
}

export async function getUserDetail(uid: string) {
  const user = await loadTarget(uid);
  const [perms, history, activity] = await Promise.all([
    usersCol().doc(uid).collection("categoryPermissions").limit(200).get(),
    query(
      `SELECT id, work_id, action, reason, moderator_id, created_at FROM moderation_actions
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [uid],
    ),
    query(
      `SELECT id, admin_id, action, target_type, metadata, created_at FROM admin_audit_logs
        WHERE target_id = $1 OR admin_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [uid],
    ),
  ]);
  return {
    user: toAdminUserDto(user),
    categoryPermissions: perms.docs.map((d) => ({ categoryId: d.id, canPost: d.get("canPost") === true })),
    moderationHistory: history.rows,
    adminActivity: activity.rows,
  };
}

/* ------------------------------ Status / role / perms ------------------------------ */

async function setStatus(actor: AuthContext, uid: string, status: AccountStatus, action: AdminAction, reason: string | undefined, log: Logger) {
  const target = await loadTarget(uid);
  assertCanManageUser({ uid: actor.uid, role: actor.profile.role }, { id: uid, role: target.role });
  if (target.accountStatus === status) return toAdminUserDto(target); // idempotent
  await usersCol().doc(uid).update({
    accountStatus: status,
    statusReason: reason ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  invalidateProfile(uid);
  if (status !== "active") {
    // Existing sessions stop being renewable. Access is also refused by the backend on every request.
    await adminAuth.revokeRefreshTokens(uid).catch((err: Error) => log.error({ uid, err: err.message }, "REVOKE_TOKENS_FAILED"));
  }
  await logAdmin({ adminId: actor.uid, action, targetType: "user", targetId: uid, metadata: { from: target.accountStatus, to: status, reason: reason ?? null } }, log);
  return toAdminUserDto((await getUserById(uid))!);
}

export const disableUser = (a: AuthContext, uid: string, reason: string | undefined, log: Logger) => setStatus(a, uid, "disabled", "USER_DISABLED", reason, log);
export const blockUser = (a: AuthContext, uid: string, reason: string | undefined, log: Logger) => setStatus(a, uid, "blocked", "USER_BLOCKED", reason, log);
export const reactivateUser = async (a: AuthContext, uid: string, reason: string | undefined, log: Logger) => {
  const target = await loadTarget(uid);
  const action: AdminAction = target.accountStatus === "blocked" ? "USER_UNBLOCKED" : "USER_REACTIVATED";
  return setStatus(a, uid, "active", action, reason, log);
};

export async function changeRole(actor: AuthContext, uid: string, role: Role, log: Logger) {
  const target = await loadTarget(uid);
  assertCanManageUser({ uid: actor.uid, role: actor.profile.role }, { id: uid, role: target.role });
  assertCanAssignRole({ uid: actor.uid, role: actor.profile.role }, role);
  if (target.role === role) return toAdminUserDto(target);

  // Never leave the platform without a super admin.
  if (target.role === "super_admin") {
    const others = await usersCol().where("role", "==", "super_admin").limit(2).get();
    if (others.docs.filter((d) => d.id !== uid).length === 0) {
      throw conflict("LAST_SUPER_ADMIN", "There must be at least one super admin.");
    }
  }
  await usersCol().doc(uid).update({ role, updatedAt: FieldValue.serverTimestamp() });
  invalidateProfile(uid);
  await logAdmin({ adminId: actor.uid, action: "USER_ROLE_CHANGED", targetType: "user", targetId: uid, metadata: { from: target.role, to: role } }, log);
  return toAdminUserDto((await getUserById(uid))!);
}

export async function changePermissions(actor: AuthContext, uid: string, patch: Record<string, boolean | undefined>, log: Logger) {
  const target = await loadTarget(uid);
  assertCanManageUser({ uid: actor.uid, role: actor.profile.role }, { id: uid, role: target.role });
  const next = { ...(target.permissions ?? {}) } as Record<string, boolean>;
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "boolean") continue;
    // An administrator cannot hand out a power they do not hold themselves.
    if (v && !actor.permissions[k as keyof typeof actor.permissions]) {
      throw new AppError("PERMISSION_NOT_GRANTABLE", `You cannot grant "${k}" because you do not hold it.`, 403);
    }
    next[k] = v;
  }
  await usersCol().doc(uid).update({ permissions: next, updatedAt: FieldValue.serverTimestamp() });
  invalidateProfile(uid);
  await logAdmin({ adminId: actor.uid, action: "USER_PERMISSION_CHANGED", targetType: "user", targetId: uid, metadata: { patch } }, log);
  return toAdminUserDto((await getUserById(uid))!);
}

export async function setCategoryPermission(actor: AuthContext, uid: string, categoryId: string, canPost: boolean, log: Logger) {
  await loadTarget(uid);
  if (!(await getCategory(categoryId))) throw notFound("CATEGORY_NOT_FOUND", "That category does not exist.");
  await usersCol().doc(uid).collection("categoryPermissions").doc(categoryId).set(
    { canPost, grantedBy: actor.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await logAdmin({ adminId: actor.uid, action: "USER_CATEGORY_PERMISSION_CHANGED", targetType: "user", targetId: uid, metadata: { categoryId, canPost } }, log);
  return { categoryId, canPost };
}

/**
 * Asks Firebase to email the user a reset link. The admin never sees the link or any password:
 * Firebase generates the link and sends the message itself.
 */
export async function triggerPasswordReset(actor: AuthContext, uid: string, log: Logger) {
  const target = await loadTarget(uid);
  assertCanManageUser({ uid: actor.uid, role: actor.profile.role }, { id: uid, role: target.role });
  if (!env.FIREBASE_WEB_API_KEY) throw unavailable("RESET_NOT_CONFIGURED", "Password reset emails are not configured.");
  const email = (await adminAuth.getUser(uid)).email;
  if (!email) throw badRequest("NO_EMAIL", "This account has no email address.");

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${env.FIREBASE_WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
  });
  if (!res.ok) {
    log.error({ uid, status: res.status }, "PASSWORD_RESET_SEND_FAILED");
    throw unavailable("RESET_FAILED", "We could not send the reset email. Please try again.");
  }
  await logAdmin({ adminId: actor.uid, action: "USER_PASSWORD_RESET_TRIGGERED", targetType: "user", targetId: uid, metadata: {} }, log);
}

/* ------------------------------------ Works ------------------------------------ */

export async function listWorksForAdmin(params: { status?: string; moderation?: string; cursor?: string; limit?: string }) {
  let q: FirebaseFirestore.Query = worksCol();
  if (params.moderation) q = q.where("moderationStatus", "==", params.moderation);
  else if (params.status) q = q.where("status", "==", params.status);
  q = q.orderBy("updatedAt", "desc").orderBy(docId(), "desc");
  const { docs, nextCursor } = await runPage(q, {
    limit: clampLimit(params.limit, 20, 50),
    cursor: params.cursor,
    cursorFields: (d) => [d.get("updatedAt"), d.id],
  });
  const works = docs.map((d) => ({ id: d.id, ...d.data() }) as Doc);
  // `viewer` is a moderator here, so moderation details are included.
  const dtos = await hydrateWorks(works, { permissions: { moderateWorks: true } } as unknown as AuthContext);
  return { items: dtos, nextCursor };
}

/**
 * Permanent deletion. Requires the work to be soft deleted first, so a single mistaken request
 * can never destroy a live work. Removes the work, all revisions, chunks, likes, comments and
 * stored media.
 */
export async function permanentlyDeleteWork(actor: AuthContext, workId: string, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  if (work.status !== "deleted") {
    throw conflict("WORK_NOT_SOFT_DELETED", "Delete the work first. Permanent deletion is only available for deleted works.");
  }
  await db.recursiveDelete(workRef(workId));
  await deletePrefix(`works/${workId}`).catch((err: Error) => log.error({ workId, err: err.message }, "MEDIA_CLEANUP_FAILED"));
  await logAdmin(
    { adminId: actor.uid, action: "WORK_PERMANENTLY_DELETED", targetType: "work", targetId: workId, metadata: { authorId: work.authorId, title: work.title } },
    log,
  );
}

/* ------------------------------------ Audit ------------------------------------ */

export async function listAuditLogs(params: { action?: string; adminId?: string; targetId?: string; before?: string; limit: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };
  if (params.action) add("action = ?", params.action);
  if (params.adminId) add("admin_id = ?", params.adminId);
  if (params.targetId) add("target_id = ?", params.targetId);
  if (params.before) add("created_at < ?", params.before);
  args.push(params.limit + 1);
  const res = await query(
    `SELECT id, admin_id, action, target_type, target_id, metadata, created_at FROM admin_audit_logs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${args.length}`,
    args,
  );
  const rows = res.rows.slice(0, params.limit);
  const next = res.rows.length > params.limit ? new Date(rows[rows.length - 1]!.created_at).toISOString() : null;
  return { items: rows, nextCursor: next };
}
