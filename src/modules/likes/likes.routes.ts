import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction } from "../../config/postgres.js";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requireFeature } from "../../middleware/authorize.js";
import { lockWork } from "../../repositories/works.repo.js";
import { track } from "../../services/analytics.service.js";
import { notify } from "../../services/notifications.service.js";
import { ok } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { notFound } from "../../utils/errors.js";
import { loadVisibleWork } from "../works/works.guards.js";

const params = z.object({ id: idParam });

export async function likeRoutes(app: FastifyInstance) {
  // Idempotent: liking twice leaves exactly one like and one count.
  app.put("/:id/like", { preHandler: [requireUser, requireFeature("allowLikes")], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const auth = getAuth(req);
    const { id } = parse(params, req.params);
    const work = await loadVisibleWork(id, auth);
    if (work.status !== "published" || work.visibility !== "public") {
      throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
    }

    const likedAt = Date.now();
    const result = await withTransaction(async (c) => {
      const locked = await lockWork(c, id);
      if (!locked) throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
      const ins = await c.query(
        `INSERT INTO work_likes (work_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, auth.uid],
      );
      if (ins.rowCount === 0) return { created: false, likeCount: Math.max(0, locked.likeCount) };
      await c.query(`UPDATE works SET like_count = like_count + 1 WHERE id = $1`, [id]);
      return { created: true, likeCount: Math.max(0, locked.likeCount) + 1 };
    });

    if (result.created) {
      track({ eventId: `like:${id}:${auth.uid}:${likedAt}`, metric: "likes" }, req.log);
      if (work.authorId !== auth.uid) {
        await notify(work.authorId, { type: "NEW_LIKE", title: "Someone liked your work", body: work.title, workId: id }, req.log);
      }
    }
    return ok({ liked: true, likeCount: result.likeCount });
  });

  app.delete("/:id/like", { preHandler: [requireUser, requireFeature("allowLikes")] }, async (req) => {
    const auth = getAuth(req);
    const { id } = parse(params, req.params);
    await loadVisibleWork(id, auth);

    const result = await withTransaction(async (c) => {
      const locked = await lockWork(c, id);
      if (!locked) throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
      const current = Math.max(0, locked.likeCount);
      const del = await c.query(`DELETE FROM work_likes WHERE work_id = $1 AND user_id = $2`, [id, auth.uid]);
      if (del.rowCount === 0) return { likeCount: current };
      await c.query(`UPDATE works SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1`, [id]);
      return { likeCount: Math.max(0, current - 1) };
    });
    return ok({ liked: false, likeCount: result.likeCount });
  });
}
