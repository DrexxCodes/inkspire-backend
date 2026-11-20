import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, optionalUser, requireUser } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/authorize.js";
import { listAllCategories, toCategoryDto } from "../../repositories/categories.repo.js";
import { listCategoryPermissions } from "../../repositories/users.repo.js";
import { settingsService } from "../../services/settings.service.js";
import { ok } from "../../utils/respond.js";
import { forbidden } from "../../utils/errors.js";
import { idParam, parse } from "../../utils/validation.js";
import {
  createCategory,
  createCategorySchema,
  deleteCategory,
  updateCategory,
  updateCategorySchema,
} from "./categories.service.js";

export async function categoryRoutes(app: FastifyInstance) {
  // Public by default shows active categories only. `?all=true` is for category managers.
  app.get("/", { preHandler: optionalUser }, async (req) => {
    const { all } = parse(z.object({ all: z.enum(["true", "false"]).optional() }), req.query);
    const wantsAll = all === "true";
    if (wantsAll && !req.auth?.permissions.manageCategories) {
      throw forbidden("INSUFFICIENT_PERMISSIONS", "You do not have permission to see inactive categories.");
    }
    const items = (await listAllCategories()).filter((c) => wantsAll || c.isActive !== false);
    return ok({ items: items.map((c) => toCategoryDto(c, true)) });
  });

  // Active categories with whether the signed in user may post in each. UX only: the backend
  // re-checks permission on every create, save and publish.
  app.get("/postable", { preHandler: requireUser }, async (req) => {
    const auth = getAuth(req);
    const [categories, explicit, settings] = await Promise.all([
      listAllCategories(),
      listCategoryPermissions(auth.uid),
      settingsService.get(),
    ]);
    const items = categories
      .filter((c) => c.isActive !== false)
      .map((c) => ({ ...toCategoryDto(c), canPost: explicit.get(c.id) ?? settings.defaultCategoryPostingAllowed }));
    return ok({ items });
  });

  app.post("/", { preHandler: [requireUser, requirePermission("manageCategories")] }, async (req, reply) => {
    const category = await createCategory(getAuth(req).uid, parse(createCategorySchema, req.body), req.log);
    reply.status(201);
    return ok({ category: toCategoryDto(category, true) });
  });

  app.patch("/:id", { preHandler: [requireUser, requirePermission("manageCategories")] }, async (req) => {
    const { id } = parse(z.object({ id: idParam }), req.params);
    const category = await updateCategory(getAuth(req).uid, id, parse(updateCategorySchema, req.body), req.log);
    return ok({ category: toCategoryDto(category, true) });
  });

  app.delete("/:id", { preHandler: [requireUser, requirePermission("manageCategories")] }, async (req) => {
    const { id } = parse(z.object({ id: idParam }), req.params);
    await deleteCategory(getAuth(req).uid, id, req.log);
    return ok({ deleted: true });
  });
}
