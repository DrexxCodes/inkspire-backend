import type { FastifyInstance } from "fastify";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/authorize.js";
import { settingsService, settingsUpdateSchema } from "../../services/settings.service.js";
import { logAdmin } from "../../services/audit.service.js";
import { parse } from "../../utils/validation.js";
import { ok } from "../../utils/respond.js";

export async function settingsRoutes(app: FastifyInstance) {
  // Safe subset for the client (limits and feature flags). No secrets, no chunk threshold.
  app.get("/public", async () => ok({ settings: await settingsService.getPublic() }));

  app.get("/", { preHandler: [requireUser, requirePermission("managePlatform")] }, async () =>
    ok({ settings: await settingsService.get() }),
  );

  app.put("/", { preHandler: [requireUser, requirePermission("managePlatform")] }, async (req) => {
    const patch = parse(settingsUpdateSchema, req.body);
    const adminId = getAuth(req).uid;
    const { before, after } = await settingsService.update(patch, adminId);
    const changed = Object.fromEntries(
      Object.keys(patch).map((k) => [k, { from: before[k as keyof typeof before], to: after[k as keyof typeof after] }]),
    );
    await logAdmin({ adminId, action: "PLATFORM_SETTING_CHANGED", targetType: "settings", targetId: "platform", metadata: { changed } }, req.log);
    return ok({ settings: after });
  });
}
