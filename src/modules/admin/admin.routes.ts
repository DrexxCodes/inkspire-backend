import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requirePermission, requireSuperAdmin } from "../../middleware/authorize.js";
import { clampLimit } from "../../utils/pagination.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { restoreWork } from "../moderation/moderation.service.js";
import { softDeleteWork } from "../works/works.service.js";
import {
  blockUser,
  changePermissions,
  changeRole,
  disableUser,
  getUserDetail,
  listAuditLogs,
  listWorksForAdmin,
  permanentlyDeleteWork,
  permissionsSchema,
  reactivateUser,
  roleSchema,
  searchUsers,
  setCategoryPermission,
  setVerification,
  statusSchema,
  triggerPasswordReset,
} from "./admin.service.js";

const uid = z.object({ uid: idParam });
const users = [requireUser, requirePermission("manageUsers")];

/** Every route in this module is guarded by Fastify authorization. Nothing here trusts the client. */
export async function adminRoutes(app: FastifyInstance) {
  /* ---------------------------------- Users ---------------------------------- */
  app.get("/users", { preHandler: users }, async (req) => {
    const q = parse(
      z.object({
        q: z.string().max(100).optional(),
        role: z.enum(["user", "moderator", "admin", "super_admin"]).optional(),
        status: z.enum(["active", "disabled", "blocked"]).optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
      req.query,
    );
    const page = await searchUsers(q);
    return okPage(page.items, page.nextCursor);
  });

  app.get("/users/:uid", { preHandler: users }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok(await getUserDetail(id, req.log));
  });

  app.post("/users/:uid/disable", { preHandler: users }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await disableUser(getAuth(req), id, parse(statusSchema, req.body ?? {}).reason, req.log) });
  });

  app.post("/users/:uid/block", { preHandler: users }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await blockUser(getAuth(req), id, parse(statusSchema, req.body ?? {}).reason, req.log) });
  });

  // Covers both "reactivate" (disabled) and "unblock" (blocked).
  app.post("/users/:uid/reactivate", { preHandler: users }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await reactivateUser(getAuth(req), id, parse(statusSchema, req.body ?? {}).reason, req.log) });
  });

  app.post("/users/:uid/password-reset", { preHandler: users, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    await triggerPasswordReset(getAuth(req), id, req.log);
    return ok({ sent: true });
  });

  app.put("/users/:uid/role", { preHandler: [requireUser, requirePermission("manageRoles")] }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await changeRole(getAuth(req), id, parse(roleSchema, req.body).role, req.log) });
  });

  app.put("/users/:uid/permissions", { preHandler: [requireUser, requirePermission("manageRoles")] }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await changePermissions(getAuth(req), id, parse(permissionsSchema, req.body).permissions, req.log) });
  });

  // Verification badge: super admins only, and nothing else grants it.
  const superAdmin = [requireUser, requireSuperAdmin];

  app.put("/users/:uid/verification", { preHandler: superAdmin }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await setVerification(getAuth(req), id, true, req.log) });
  });

  app.delete("/users/:uid/verification", { preHandler: superAdmin }, async (req) => {
    const { uid: id } = parse(uid, req.params);
    return ok({ user: await setVerification(getAuth(req), id, false, req.log) });
  });

  app.put("/users/:uid/category-permissions/:categoryId", { preHandler: users }, async (req) => {
    const p = parse(z.object({ uid: idParam, categoryId: idParam }), req.params);
    const { canPost } = parse(z.object({ canPost: z.boolean() }), req.body);
    return ok(await setCategoryPermission(getAuth(req), p.uid, p.categoryId, canPost, req.log));
  });

  /* ---------------------------------- Works ---------------------------------- */
  const moderate = [requireUser, requirePermission("moderateWorks")];

  app.get("/works", { preHandler: moderate }, async (req) => {
    const q = parse(
      z.object({
        status: z.enum(["draft", "published", "flagged", "archived", "deleted"]).optional(),
        moderation: z.enum(["clean", "flagged", "underReview", "approved", "rejected"]).optional(),
        cursor: z.string().optional(),
        limit: z.string().optional(),
      }),
      req.query,
    );
    const page = await listWorksForAdmin(q);
    return okPage(page.items, page.nextCursor);
  });

  app.delete("/works/:id", { preHandler: [requireUser, requirePermission("deleteWorks")] }, async (req) => {
    const { id } = parse(z.object({ id: idParam }), req.params);
    await softDeleteWork(getAuth(req), id, req.log);
    return ok({ deleted: true });
  });

  app.post("/works/:id/restore", { preHandler: [requireUser, requirePermission("deleteWorks")] }, async (req) => {
    const { id } = parse(z.object({ id: idParam }), req.params);
    await restoreWork(getAuth(req), id, req.log);
    return ok({ restored: true });
  });

  // Stronger permission, a soft deleted target and an explicit confirmation flag are all required.
  app.post("/works/:id/permanent-delete", { preHandler: [requireUser, requirePermission("permanentlyDeleteWorks")] }, async (req) => {
    const { id } = parse(z.object({ id: idParam }), req.params);
    parse(z.object({ confirm: z.literal(true) }), req.body);
    await permanentlyDeleteWork(getAuth(req), id, req.log);
    return ok({ deleted: true });
  });

  /* ---------------------------------- Audit ---------------------------------- */
  app.get("/audit-logs", { preHandler: [requireUser, requirePermission("manageUsers")] }, async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(60).optional(),
        adminId: idParam.optional(),
        targetId: idParam.optional(),
        before: z.string().datetime().optional(),
        limit: z.string().optional(),
      }),
      req.query,
    );
    const page = await listAuditLogs({ ...q, limit: clampLimit(q.limit, 30, 100) });
    return okPage(page.items, page.nextCursor);
  });
}
