import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { clampLimit } from "../../utils/pagination.js";
import { settingsService } from "../../services/settings.service.js";
import { autosaveSchema, chunkQuerySchema, saveRevisionSchema } from "../works/works.schemas.js";
import { loadOwnWork } from "../works/works.guards.js";
import { getWorkDto, publishWork } from "../works/works.service.js";
import {
  getDraftState,
  getRevision,
  listRevisions,
  promoteRevision,
  readDraftContent,
  readRevisionContent,
  restoreRevision,
  saveDraftState,
  saveRevision,
} from "./revisions.service.js";

const workParams = z.object({ id: idParam });
const revParams = z.object({ id: idParam, revisionId: z.string().regex(/^r\d{1,9}$/) });

/**
 * All revision routes are author only. Revisions hold the author's complete history, including
 * versions that were never public, so moderators read the revision attached to a review instead.
 */
export async function revisionRoutes(app: FastifyInstance) {
  // Explicit save: creates an immutable revision. By default it also becomes the current version.
  app.post("/:id/revisions", { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = getAuth(req);
    const { id } = parse(workParams, req.params);
    const body = parse(saveRevisionSchema, req.body);
    const work = await loadOwnWork(id, auth);
    const settings = await settingsService.get();

    const result = await saveRevision(
      {
        work,
        actor: auth,
        settings,
        makeCurrent: body.makeCurrent,
        changeReason: body.changeReason,
        basedOnRevisionId: body.basedOnRevisionId,
        input: {
          title: body.title,
          description: body.description,
          categoryId: body.categoryId,
          coverImageUrl: body.coverImageUrl ?? work.coverImageUrl,
          content: body.content,
        },
      },
      req.log,
    );
    if (body.publish && body.makeCurrent) await publishWork(auth, id, req.log);

    reply.status(201);
    return ok({ revision: result, work: await getWorkDto(id, auth) });
  });

  app.get("/:id/revisions", { preHandler: requireUser }, async (req) => {
    const { id } = parse(workParams, req.params);
    const q = parse(z.object({ cursor: z.string().optional(), limit: z.string().optional() }), req.query);
    const work = await loadOwnWork(id, getAuth(req));
    const page = await listRevisions(work, { cursor: q.cursor, limit: clampLimit(q.limit, 20, 50) });
    return okPage(page.items, page.nextCursor);
  });

  app.get("/:id/revisions/:revisionId", { preHandler: requireUser }, async (req) => {
    const { id, revisionId } = parse(revParams, req.params);
    const work = await loadOwnWork(id, getAuth(req));
    return ok({ revision: await getRevision(work, revisionId) });
  });

  app.get("/:id/revisions/:revisionId/content", { preHandler: requireUser }, async (req) => {
    const { id, revisionId } = parse(revParams, req.params);
    const q = parse(chunkQuerySchema, req.query);
    const work = await loadOwnWork(id, getAuth(req));
    const page = await readRevisionContent(work, revisionId, q.after === undefined ? undefined : Number(q.after), clampLimit(q.limit, 3, 5));
    return ok(page);
  });

  // "Promote": make an existing checkpoint the live version without creating anything new.
  app.post("/:id/revisions/:revisionId/promote", { preHandler: requireUser }, async (req) => {
    const auth = getAuth(req);
    const { id, revisionId } = parse(revParams, req.params);
    const work = await loadOwnWork(id, auth);
    await promoteRevision(work, auth, revisionId, await settingsService.get(), req.log);
    return ok({ work: await getWorkDto(id, auth) });
  });

  // "Restore as new revision": appends a copy of an old revision, so history is never rewritten.
  app.post("/:id/revisions/:revisionId/restore", { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = getAuth(req);
    const { id, revisionId } = parse(revParams, req.params);
    const work = await loadOwnWork(id, auth);
    const result = await restoreRevision(work, auth, revisionId, await settingsService.get(), req.log);
    reply.status(201);
    return ok({ revision: result, work: await getWorkDto(id, auth) });
  });

  /* ------------------------------- Autosave ------------------------------- */

  // Writes the "current draft state". Never creates a revision.
  app.put("/:id/draft-state", { preHandler: requireUser, config: { rateLimit: { max: 90, timeWindow: "1 minute" } } }, async (req) => {
    const auth = getAuth(req);
    const { id } = parse(workParams, req.params);
    const body = parse(autosaveSchema, req.body);
    const work = await loadOwnWork(id, auth);
    const saved = await saveDraftState(work, body, await settingsService.get(), req.log);
    return ok(saved);
  });

  app.get("/:id/draft-state", { preHandler: requireUser }, async (req) => {
    const { id } = parse(workParams, req.params);
    await loadOwnWork(id, getAuth(req));
    return ok({ draftState: await getDraftState(id) });
  });

  app.get("/:id/draft-state/content", { preHandler: requireUser }, async (req) => {
    const { id } = parse(workParams, req.params);
    const q = parse(chunkQuerySchema, req.query);
    await loadOwnWork(id, getAuth(req));
    return ok(await readDraftContent(id, q.after === undefined ? undefined : Number(q.after), clampLimit(q.limit, 3, 5)));
  });
}
