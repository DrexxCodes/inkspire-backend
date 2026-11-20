import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { env } from "./config/env.js";
import { registerSecurity } from "./plugins/security.js";
import { registerErrorHandling } from "./plugins/errors.js";
import { registerRequestLogging } from "./plugins/request-logging.js";
import { ViewAggregator } from "./services/views.service.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { userRoutes } from "./modules/users/users.routes.js";
import { categoryRoutes } from "./modules/categories/categories.routes.js";
import { workRoutes } from "./modules/works/works.routes.js";
import { revisionRoutes } from "./modules/revisions/revisions.routes.js";
import { likeRoutes } from "./modules/likes/likes.routes.js";
import { commentRoutes } from "./modules/comments/comments.routes.js";
import { shareRoutes } from "./modules/shares/shares.routes.js";
import { moderationRoutes } from "./modules/moderation/moderation.routes.js";
import { analyticsRoutes } from "./modules/analytics/analytics.routes.js";
import { notificationRoutes } from "./modules/notifications/notifications.routes.js";
import { adminRoutes } from "./modules/admin/admin.routes.js";
import { settingsRoutes } from "./modules/settings/settings.routes.js";

declare module "fastify" {
  interface FastifyInstance {
    views: ViewAggregator;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token"],
    },
    disableRequestLogging: true, // replaced by plugins/request-logging.ts
    genReqId: (req) => (typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 64) : randomUUID()),
    trustProxy: env.isProd,
    bodyLimit: 12 * 1024 * 1024, // room for a 5 MB work, which is JSON escaped
  });

  registerErrorHandling(app);
  registerRequestLogging(app);
  await registerSecurity(app);

  const views = new ViewAggregator(app.log);
  views.start();
  app.decorate("views", views);
  app.addHook("onClose", async () => {
    await views.stop();
  });

  app.get("/health", async () => ({ success: true, data: { status: "ok" } }));

  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: "/auth" });
      await v1.register(userRoutes, { prefix: "/users" });
      await v1.register(categoryRoutes, { prefix: "/categories" });
      await v1.register(workRoutes, { prefix: "/works" });
      await v1.register(revisionRoutes, { prefix: "/works" });
      await v1.register(likeRoutes, { prefix: "/works" });
      await v1.register(commentRoutes, { prefix: "/works" });
      await v1.register(shareRoutes, { prefix: "/works" });
      await v1.register(moderationRoutes, { prefix: "/moderation" });
      await v1.register(analyticsRoutes, { prefix: "/analytics" });
      await v1.register(notificationRoutes, { prefix: "/notifications" });
      await v1.register(adminRoutes, { prefix: "/admin" });
      await v1.register(settingsRoutes, { prefix: "/settings" });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
