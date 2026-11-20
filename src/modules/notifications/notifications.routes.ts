import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase.js";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { clampLimit, docId, runPage } from "../../utils/pagination.js";
import { serialize } from "../../utils/serialize.js";
import { idParam, parse } from "../../utils/validation.js";
import { ok, okPage } from "../../utils/respond.js";

const col = (uid: string) => db.collection("users").doc(uid).collection("notifications");

export async function notificationRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireUser }, async (req) => {
    const q = parse(z.object({ cursor: z.string().optional(), limit: z.string().optional() }), req.query);
    const { docs, nextCursor } = await runPage(col(getAuth(req).uid).orderBy("createdAt", "desc").orderBy(docId(), "desc"), {
      limit: clampLimit(q.limit, 20, 50),
      cursor: q.cursor,
      cursorFields: (d) => [d.get("createdAt"), d.id],
    });
    return okPage(docs.map((d) => serialize({ id: d.id, ...d.data() })), nextCursor);
  });

  app.get("/unread-count", { preHandler: requireUser }, async (req) => {
    const agg = await col(getAuth(req).uid).where("read", "==", false).count().get();
    return ok({ count: agg.data().count });
  });

  app.post("/read-all", { preHandler: requireUser }, async (req) => {
    const snap = await col(getAuth(req).uid).where("read", "==", false).limit(400).get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.update(d.ref, { read: true, readAt: FieldValue.serverTimestamp() }));
    if (!snap.empty) await batch.commit();
    return ok({ updated: snap.size });
  });

  app.post("/:id/read", { preHandler: requireUser }, async (req) => {
    const { id } = parse(z.object({ id: idParam }), req.params);
    await col(getAuth(req).uid).doc(id).update({ read: true, readAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    return ok({ read: true });
  });
}
