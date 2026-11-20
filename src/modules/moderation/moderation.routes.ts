import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/authorize.js";
import { getWork, revisionRef } from "../../repositories/works.repo.js";
import { readChunks } from "../../services/content.service.js";
import { revisionChunks } from "../../repositories/works.repo.js";
import { clampLimit } from "../../utils/pagination.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { notFound } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import {
  approveWork,
  flagWork,
  listPendingReviews,
  moderationHistory,
  rejectWork,
  requestReview,
  unflagWork,
} from "./moderation.service.js";

const workParams = z.object({ id: idParam });
const reasonBody = z.object({ reason: z.string().trim().max(2000).optional() });
const moderate = [requireUser, requirePermission("moderateWorks")];

export async function moderationRoutes(app: FastifyInstance) {
  // Author: ask for another review after revising a flagged work.
  app.post("/works/:id/request-review", { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(workParams, req.params);
    const { revisionId } = parse(z.object({ revisionId: z.string().regex(/^r\d{1,9}$/) }), req.body);
    return ok(await requestReview(getAuth(req), id, revisionId, req.log));
  });

  app.get("/queue", { preHandler: moderate }, async (req) => {
    const q = parse(z.object({ cursor: z.string().optional(), limit: z.string().optional() }), req.query);
    const page = await listPendingReviews(q);
    return okPage(page.items, page.nextCursor);
  });

  app.post("/works/:id/flag", { preHandler: moderate }, async (req) => {
    const { id } = parse(workParams, req.params);
    return ok(await flagWork(getAuth(req), id, parse(reasonBody, req.body).reason, req.log));
  });

  app.post("/works/:id/unflag", { preHandler: moderate }, async (req) => {
    const { id } = parse(workParams, req.params);
    await unflagWork(getAuth(req), id, parse(reasonBody, req.body).reason, req.log);
    return ok({ unflagged: true });
  });

  app.post("/works/:id/approve", { preHandler: moderate }, async (req) => {
    const { id } = parse(workParams, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(2000).optional() }), req.body ?? {});
    await approveWork(getAuth(req), id, note, req.log);
    return ok({ approved: true });
  });

  app.post("/works/:id/reject", { preHandler: moderate }, async (req) => {
    const { id } = parse(workParams, req.params);
    await rejectWork(getAuth(req), id, parse(reasonBody, req.body).reason, req.log);
    return ok({ rejected: true });
  });

  // The revision under review, readable by moderators only while a review is pending.
  app.get("/works/:id/review-content", { preHandler: moderate }, async (req) => {
    const { id } = parse(workParams, req.params);
    const q = parse(z.object({ after: z.string().regex(/^\d+$/).optional(), limit: z.string().optional() }), req.query);
    const work = await getWork(id);
    const reviewId = work?.moderation?.reviewId as string | undefined;
    if (!work || !reviewId) throw notFound("REVIEW_NOT_FOUND", "This work has no pending review.");
    const revisionId = reviewId.slice(id.length + 1);
    const rev = await revisionRef(id, revisionId).get();
    if (!rev.exists) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
    const page = await readChunks(revisionChunks(id, revisionId), "", q.after === undefined ? undefined : Number(q.after), clampLimit(q.limit, 3, 5));
    return ok({ revision: serialize({ id: rev.id, revisionNumber: rev.get("revisionNumber"), title: rev.get("title") }), ...page });
  });

  app.get("/history", { preHandler: moderate }, async (req) => {
    const q = parse(
      z.object({ workId: idParam.optional(), userId: idParam.optional(), before: z.string().datetime().optional(), limit: z.string().optional() }),
      req.query,
    );
    const page = await moderationHistory({ workId: q.workId, userId: q.userId }, clampLimit(q.limit, 30, 100), q.before);
    return okPage(page.items, page.nextCursor);
  });
}
