import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase.js";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requireFeature } from "../../middleware/authorize.js";
import { likesCol, workRef } from "../../repositories/works.repo.js";
import { usersCol } from "../../repositories/users.repo.js";
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
    const result = await db.runTransaction(async (tx) => {
      const likeRef = likesCol(id).doc(auth.uid);
      const [like, snap] = await Promise.all([tx.get(likeRef), tx.get(workRef(id))]);
      if (like.exists) return { created: false, likeCount: Math.max(0, (snap.get("likeCount") as number) ?? 0) };
      tx.create(likeRef, { userId: auth.uid, createdAt: FieldValue.serverTimestamp(), createdAtMs: likedAt });
      tx.update(workRef(id), { likeCount: FieldValue.increment(1) });
      tx.set(usersCol().doc(work.authorId as string), { likesReceived: FieldValue.increment(1) }, { merge: true });
      return { created: true, likeCount: ((snap.get("likeCount") as number) ?? 0) + 1 };
    });

    if (result.created) {
      track({ eventId: `like:${id}:${auth.uid}:${likedAt}`, metric: "likes" }, req.log);
      if (work.authorId !== auth.uid) {
        await notify(work.authorId as string, { type: "NEW_LIKE", title: "Someone liked your work", body: work.title as string, workId: id }, req.log);
      }
    }
    return ok({ liked: true, likeCount: result.likeCount });
  });

  app.delete("/:id/like", { preHandler: [requireUser, requireFeature("allowLikes")] }, async (req) => {
    const auth = getAuth(req);
    const { id } = parse(params, req.params);
    const work = await loadVisibleWork(id, auth);

    const result = await db.runTransaction(async (tx) => {
      const likeRef = likesCol(id).doc(auth.uid);
      const [like, snap] = await Promise.all([tx.get(likeRef), tx.get(workRef(id))]);
      const current = Math.max(0, (snap.get("likeCount") as number) ?? 0);
      if (!like.exists) return { likeCount: current };
      tx.delete(likeRef);
      tx.update(workRef(id), { likeCount: FieldValue.increment(-1) });
      tx.set(usersCol().doc(work.authorId as string), { likesReceived: FieldValue.increment(-1) }, { merge: true });
      return { likeCount: Math.max(0, current - 1) };
    });
    return ok({ liked: false, likeCount: result.likeCount });
  });
}
