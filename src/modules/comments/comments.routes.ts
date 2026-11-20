import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase.js";
import { getAuth, optionalUser, requireUser } from "../../middleware/authenticate.js";
import { requireFeature } from "../../middleware/authorize.js";
import { commentsCol, workRef } from "../../repositories/works.repo.js";
import { getUsersByIds, toAuthorSummary } from "../../repositories/users.repo.js";
import { settingsService } from "../../services/settings.service.js";
import { newEventId, track } from "../../services/analytics.service.js";
import { notify } from "../../services/notifications.service.js";
import { badRequest, forbidden, notFound } from "../../utils/errors.js";
import { clampLimit, docId, runPage } from "../../utils/pagination.js";
import { serialize } from "../../utils/serialize.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { loadVisibleWork } from "../works/works.guards.js";

const workParams = z.object({ id: idParam });
const commentParams = z.object({ id: idParam, commentId: idParam });
const createSchema = z.object({
  content: z.string().trim().min(1, "Write something first."),
  parentCommentId: idParam.nullish(),
});

async function toDtos(docs: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const users = await getUsersByIds(docs.map((d) => d.get("userId") as string));
  return docs.map((d) => {
    const deleted = d.get("status") === "deleted";
    return serialize({
      id: d.id,
      content: deleted ? "" : d.get("content"),
      status: d.get("status"),
      parentCommentId: d.get("parentCommentId") ?? null,
      replyCount: Math.max(0, d.get("replyCount") ?? 0),
      likeCount: Math.max(0, d.get("likeCount") ?? 0),
      createdAt: d.get("createdAt"),
      updatedAt: d.get("updatedAt"),
      author: toAuthorSummary(users.get(d.get("userId") as string)),
      authorId: d.get("userId"),
    });
  });
}

export async function commentRoutes(app: FastifyInstance) {
  // Top level comments (newest first), or the replies of one comment (oldest first).
  app.get("/:id/comments", { preHandler: optionalUser }, async (req) => {
    const { id } = parse(workParams, req.params);
    const q = parse(z.object({ parent: idParam.optional(), cursor: z.string().optional(), limit: z.string().optional() }), req.query);
    await loadVisibleWork(id, req.auth);

    const replies = !!q.parent;
    const base = commentsCol(id).where("parentCommentId", "==", q.parent ?? null);
    const query = replies
      ? base.orderBy("createdAt", "asc").orderBy(docId(), "asc")
      : base.orderBy("createdAt", "desc").orderBy(docId(), "desc");
    const { docs, nextCursor } = await runPage(query, {
      limit: clampLimit(q.limit, replies ? 20 : 10, 30),
      cursor: q.cursor,
      cursorFields: (d) => [d.get("createdAt"), d.id],
    });
    // Moderator removed comments stay as a placeholder only when they have replies.
    const visible = docs.filter((d) => d.get("status") !== "deleted" || (d.get("replyCount") ?? 0) > 0);
    return okPage(await toDtos(visible), nextCursor);
  });

  app.post("/:id/comments", { preHandler: [requireUser, requireFeature("allowComments")], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const auth = getAuth(req);
    const { id } = parse(workParams, req.params);
    const body = parse(createSchema, req.body);
    const settings = await settingsService.get();
    if (body.content.length > settings.maxCommentLength) {
      throw badRequest("COMMENT_TOO_LONG", `Comments can be at most ${settings.maxCommentLength} characters.`);
    }
    const work = await loadVisibleWork(id, auth);
    if (work.status !== "published" || work.visibility !== "public") {
      throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
    }

    const ref = commentsCol(id).doc();
    await db.runTransaction(async (tx) => {
      // Threads are two levels deep: a reply to a reply attaches to the original comment.
      let parentId: string | null = null;
      if (body.parentCommentId) {
        const parent = await tx.get(commentsCol(id).doc(body.parentCommentId));
        if (!parent.exists || parent.get("status") !== "active") {
          throw notFound("COMMENT_NOT_FOUND", "The comment you are replying to no longer exists.");
        }
        parentId = (parent.get("parentCommentId") as string | null) ?? parent.id;
        tx.update(commentsCol(id).doc(parentId), { replyCount: FieldValue.increment(1) });
      }
      tx.create(ref, {
        userId: auth.uid,
        content: body.content,
        parentCommentId: parentId,
        status: "active",
        likeCount: 0,
        replyCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(workRef(id), { commentCount: FieldValue.increment(1) });
    });

    track({ eventId: newEventId(`comment:${ref.id}`), metric: "comments" }, req.log);
    if (work.authorId !== auth.uid) {
      await notify(work.authorId as string, { type: "NEW_COMMENT", title: "New comment on your work", body: work.title as string, workId: id }, req.log);
    }
    const created = await ref.get();
    reply.status(201);
    return ok({ comment: (await toDtos([created as FirebaseFirestore.QueryDocumentSnapshot]))[0] });
  });

  // Authors can remove their own comments. Moderators can remove any.
  app.delete("/:id/comments/:commentId", { preHandler: requireUser }, async (req) => {
    const auth = getAuth(req);
    const { id, commentId } = parse(commentParams, req.params);
    await db.runTransaction(async (tx) => {
      const ref = commentsCol(id).doc(commentId);
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get("status") === "deleted") throw notFound("COMMENT_NOT_FOUND", "That comment does not exist.");
      if (snap.get("userId") !== auth.uid && !auth.permissions.moderateWorks) {
        throw forbidden("INSUFFICIENT_PERMISSIONS", "You can only delete your own comments.");
      }
      tx.update(ref, { status: "deleted", content: "", deletedBy: auth.uid, updatedAt: FieldValue.serverTimestamp() });
      tx.update(workRef(id), { commentCount: FieldValue.increment(-1) });
      const parentId = snap.get("parentCommentId") as string | null;
      if (parentId) tx.update(commentsCol(id).doc(parentId), { replyCount: FieldValue.increment(-1) });
    });
    return ok({ deleted: true });
  });
}
