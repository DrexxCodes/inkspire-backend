import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, optionalUser, requireUser } from "../../middleware/authenticate.js";
import { getUserByUsername, getUserById, toPrivateProfile, toPublicProfile } from "../../repositories/users.repo.js";
import { notFound, badRequest, forbidden } from "../../utils/errors.js";
import { parse } from "../../utils/validation.js";
import { ok, okPage } from "../../utils/respond.js";
import { clampLimit } from "../../utils/pagination.js";
import { listAuthorPublicWorks } from "../works/works.service.js";
import { removePhoto, savePhoto, updateProfileSchema, updateProfile, type PhotoKind } from "./users.service.js";

/** How many of an author's works a signed out visitor can see. */
export const GUEST_AUTHOR_WORKS_LIMIT = 12;

const kindQuery = z.object({ kind: z.enum(["profile", "cover"]) });

export async function userRoutes(app: FastifyInstance) {
  app.get("/:username", { preHandler: optionalUser }, async (req) => {
    const { username } = parse(z.object({ username: z.string().min(1).max(40) }), req.params);
    const user = await getUserByUsername(username);
    // Blocked accounts disappear from public view. Administrators can still open them.
    if (!user || (user.accountStatus === "blocked" && !req.auth?.permissions.manageUsers)) {
      throw notFound("USER_NOT_FOUND", "That profile does not exist.");
    }
    return ok({ profile: toPublicProfile(user) });
  });

  app.get("/:username/works", { preHandler: optionalUser }, async (req) => {
    const { username } = parse(z.object({ username: z.string().min(1).max(40) }), req.params);
    const q = parse(z.object({ cursor: z.string().optional(), limit: z.string().optional() }), req.query);
    const user = await getUserByUsername(username);
    if (!user || user.accountStatus === "blocked") throw notFound("USER_NOT_FOUND", "That profile does not exist.");
    if (!req.auth) {
      // Signed out: one page only, no cursor to follow. `gated` tells the client there is more.
      if (q.cursor) throw forbidden("LOGIN_REQUIRED", "Log in or create your account to view more.");
      const first = await listAuthorPublicWorks(user.id, { limit: GUEST_AUTHOR_WORKS_LIMIT }, null);
      return okPage(first.items, null, { gated: first.nextCursor !== null });
    }
    const page = await listAuthorPublicWorks(user.id, { cursor: q.cursor, limit: clampLimit(q.limit, 12, 30) }, req.auth);
    return okPage(page.items, page.nextCursor);
  });

  app.patch("/me", { preHandler: requireUser }, async (req) => {
    const auth = getAuth(req);
    await updateProfile(auth.profile, parse(updateProfileSchema, req.body));
    const fresh = await getUserById(auth.uid);
    return ok({ profile: toPrivateProfile(fresh!) });
  });

  // Multipart upload: one image file, JPEG/PNG/WebP, 5 MB maximum, verified by content.
  app.post("/me/photo", { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const auth = getAuth(req);
    const { kind } = parse(kindQuery, req.query);
    const file = await req.file();
    if (!file) throw badRequest("NO_FILE", "Attach an image to upload.");
    const buffer = await file.toBuffer();
    const url = await savePhoto(auth.profile, kind as PhotoKind, buffer);
    return ok({ url });
  });

  app.delete("/me/photo", { preHandler: requireUser }, async (req) => {
    const auth = getAuth(req);
    const { kind } = parse(kindQuery, req.query);
    const url = await removePhoto(auth.profile, kind as PhotoKind);
    return ok({ url });
  });
}
