import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, optionalUser, requireUser } from "../../middleware/authenticate.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { clampLimit } from "../../utils/pagination.js";
import { badRequest, forbidden } from "../../utils/errors.js";
import { viewerKey } from "../../utils/request.js";
import { uploadPublic, ALLOWED_IMAGE_TYPES, sniffImageType } from "../../services/storage.service.js";
import { workRef } from "../../repositories/works.repo.js";
import { FieldValue } from "firebase-admin/firestore";
import { chunkQuerySchema, createWorkSchema, listQuerySchema } from "./works.schemas.js";
import { loadOwnWork, loadVisibleWork } from "./works.guards.js";
import {
  archiveWork,
  createWork,
  getWorkDto,
  listMyWorks,
  listPublicWorks,
  publishWork,
  readWorkContent,
  setVisibility,
  softDeleteWork,
} from "./works.service.js";

const idParams = z.object({ id: idParam });

/** How many works a signed out visitor can see in discovery. */
export const GUEST_FEED_LIMIT = 20;

export async function workRoutes(app: FastifyInstance) {
  // Discovery. Only published + public works are ever returned.
  // Signed out visitors only ever get the first GUEST_FEED_LIMIT works. There is no cursor to follow,
  // and `gated` tells the client there is more behind signing in.
  app.get("/", { preHandler: optionalUser }, async (req) => {
    const q = parse(listQuerySchema, req.query);
    if (req.auth) {
      const page = await listPublicWorks(q, req.auth);
      return okPage(page.items, page.nextCursor);
    }
    if (q.cursor) throw forbidden("LOGIN_REQUIRED", "Log in or create your account to view more.");
    const page = await listPublicWorks({ ...q, limit: String(GUEST_FEED_LIMIT) }, null);
    return okPage(page.items, null, { gated: page.nextCursor !== null });
  });

  app.get("/mine", { preHandler: requireUser }, async (req) => {
    const q = parse(z.object({ status: z.enum(["draft", "published", "flagged", "archived"]).optional(), cursor: z.string().optional(), limit: z.string().optional() }), req.query);
    const page = await listMyWorks(getAuth(req), q);
    return okPage(page.items, page.nextCursor);
  });

  app.post("/", { preHandler: requireUser, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const work = await createWork(getAuth(req), parse(createWorkSchema, req.body), req.log);
    reply.status(201);
    return ok({ work });
  });

  // Metadata first. The reader then streams content with GET /:id/content.
  app.get("/:id", { preHandler: optionalUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ work: await getWorkDto(id, req.auth) });
  });

  app.get("/:id/content", { preHandler: optionalUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(chunkQuerySchema, req.query);
    const page = await readWorkContent(id, req.auth, {
      after: q.after === undefined ? undefined : Number(q.after),
      limit: clampLimit(q.limit, 3, 5),
      revisionId: q.revisionId,
    });
    return ok(page);
  });

  // Counted once per viewer per 30 minutes and flushed in aggregate (see ViewAggregator).
  app.post("/:id/view", { preHandler: optionalUser, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const work = await loadVisibleWork(id, req.auth);
    // Authors and unpublished previews do not inflate view counts.
    const counts = work.status === "published" && work.visibility === "public" && work.authorId !== req.auth?.uid;
    return ok({ counted: counts ? app.views.record(id, viewerKey(req)) : false });
  });

  app.post("/:id/publish", { preHandler: requireUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ work: await publishWork(getAuth(req), id, req.log) });
  });

  app.post("/:id/archive", { preHandler: requireUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ work: await archiveWork(getAuth(req), id) });
  });

  app.patch("/:id/visibility", { preHandler: requireUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { visibility } = parse(z.object({ visibility: z.enum(["public", "private"]) }), req.body);
    return ok({ work: await setVisibility(getAuth(req), id, visibility) });
  });

  app.delete("/:id", { preHandler: requireUser }, async (req) => {
    const { id } = parse(idParams, req.params);
    await softDeleteWork(getAuth(req), id, req.log);
    return ok({ deleted: true });
  });

  // Cover image upload. JPEG, PNG or WebP, 5 MB maximum, verified by content.
  app.post("/:id/cover", { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const auth = getAuth(req);
    await loadOwnWork(id, auth);
    const file = await req.file();
    if (!file) throw badRequest("NO_FILE", "Attach an image to upload.");
    const buffer = await file.toBuffer();
    const type = sniffImageType(buffer);
    if (!type || !ALLOWED_IMAGE_TYPES[type]) throw badRequest("UNSUPPORTED_IMAGE", "Please upload a JPEG, PNG or WebP image.");
    const url = await uploadPublic(`works/${id}/cover.${ALLOWED_IMAGE_TYPES[type]}`, buffer, type);
    await workRef(id).update({ coverImageUrl: url, updatedAt: FieldValue.serverTimestamp() });
    return ok({ url });
  });
}
