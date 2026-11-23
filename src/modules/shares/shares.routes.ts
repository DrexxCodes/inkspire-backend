import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../config/postgres.js";
import { optionalUser } from "../../middleware/authenticate.js";
import { requireFeature } from "../../middleware/authorize.js";
import { newEventId, track } from "../../services/analytics.service.js";
import { TtlSet } from "../../utils/ttl-set.js";
import { viewerKey } from "../../utils/request.js";
import { ok } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { notFound } from "../../utils/errors.js";
import { loadVisibleWork } from "../works/works.guards.js";

const params = z.object({ id: idParam });
const body = z.object({
  platform: z.enum(["copy_link", "whatsapp", "x", "facebook", "telegram", "native_share"]),
});

/** Double taps and retries inside this window are ignored. Nothing is stored permanently. */
const recent = new TtlSet(60_000, 50_000);

export async function shareRoutes(app: FastifyInstance) {
  // Only an aggregate counter and an analytics event are kept, never one document per share.
  app.post("/:id/share", { preHandler: [optionalUser, requireFeature("allowSharing")], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(params, req.params);
    const { platform } = parse(body, req.body);
    const work = await loadVisibleWork(id, req.auth);
    if (work.status !== "published" || work.visibility !== "public") {
      throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
    }

    const fresh = recent.addIfNew(`${id}:${platform}:${viewerKey(req)}`);
    if (fresh) {
      await pool.query(`UPDATE works SET share_count = share_count + 1 WHERE id = $1`, [id]);
      track({ eventId: newEventId(`share:${id}`), metric: "shares" }, req.log);
    }
    return ok({ counted: fresh });
  });
}
