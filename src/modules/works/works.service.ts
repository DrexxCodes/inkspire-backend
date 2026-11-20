import { createHash } from "node:crypto";
import { FieldValue, type Query } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../../config/firebase.js";
import type { AuthContext, Doc } from "../../types/domain.js";
import {
  draftChunks,
  getWork,
  hydrateWorks,
  likesCol,
  revisionChunks,
  revisionRef,
  reviewsCol,
  workChunks,
  workRef,
  worksCol,
} from "../../repositories/works.repo.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { makeExcerpt } from "../../utils/text.js";
import { clampLimit, docId, runPage } from "../../utils/pagination.js";
import { deleteDocs, prepareContent, readChunks, writeChunks } from "../../services/content.service.js";
import { settingsService } from "../../services/settings.service.js";
import { applyPublishedDelta, statsIncrement, statsRef } from "../../services/stats.service.js";
import { track } from "../../services/analytics.service.js";
import { logAdmin, logModeration } from "../../services/audit.service.js";
import { softDelete as softDeleteTransition } from "../moderation/moderation.rules.js";
import { assertPostingAllowed, loadOwnWork, loadVisibleWork } from "./works.guards.js";
import { createWorkSchema, listQuerySchema } from "./works.schemas.js";

type Logger = Parameters<typeof track>[1] & Parameters<typeof logAdmin>[1];

const idemRef = (uid: string, key: string) =>
  db.collection("idempotency").doc(createHash("sha256").update(`${uid}:${key}`).digest("hex").slice(0, 40));

const isAlreadyExists = (err: unknown) => (err as { code?: number })?.code === 6;

export async function getWorkDto(workId: string, auth?: AuthContext | null) {
  const work = await loadVisibleWork(workId, auth);
  const [dto] = await hydrateWorks([work], auth);
  let liked = false;
  if (auth) liked = (await likesCol(workId).doc(auth.uid).get()).exists;
  return { ...dto!, viewer: { isAuthor: auth?.uid === work.authorId, liked } };
}

/* ---------------------------------- Create ---------------------------------- */

export async function createWork(auth: AuthContext, input: z.output<typeof createWorkSchema>, log: Logger) {
  const settings = await settingsService.get();

  if (input.idempotencyKey) {
    const prior = await idemRef(auth.uid, input.idempotencyKey).get();
    if (prior.exists) return getWorkDto(prior.get("workId") as string, auth);
  }

  await assertPostingAllowed(auth.uid, input.categoryId, settings.defaultCategoryPostingAllowed);
  const prepared = prepareContent(input.content, {
    thresholdBytes: settings.contentChunkThresholdBytes,
    maxWorkSizeBytes: settings.maxWorkSizeBytes,
  });

  const workId = worksCol().doc().id;
  const revisionId = "r1";
  const excerpt = makeExcerpt(input.content);
  const publish = input.publish;

  // 1. Content first. Nothing points at these chunks yet, so a failure leaves nothing visible.
  const revisionIds = await writeChunks(revisionChunks(workId, revisionId), "", prepared.chunks);
  let workChunkIds: string[] = [];

  try {
    workChunkIds = await writeChunks(workChunks(workId), `${revisionId}_`, prepared.chunks, { revisionId });

    // 2. Metadata last, in one atomic batch: work, first revision, counters, idempotency marker.
    const batch = db.batch();
    batch.create(workRef(workId), {
      authorId: auth.uid,
      title: input.title,
      titleLower: input.title.toLowerCase(),
      description: input.description,
      excerpt,
      categoryId: input.categoryId,
      coverImageUrl: input.coverImageUrl ?? null,
      status: publish ? "published" : "draft",
      visibility: input.visibility,
      moderationStatus: "clean",
      moderation: null,
      chunkCount: prepared.chunks.length,
      totalBytes: prepared.totalBytes,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      viewCount: 0,
      currentRevisionId: revisionId,
      lastRevisionNumber: 1,
      publishCount: publish ? 1 : 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      publishedAt: publish ? FieldValue.serverTimestamp() : null,
      deletedAt: null,
      deletedBy: null,
    });
    batch.create(revisionRef(workId, revisionId), {
      revisionNumber: 1,
      title: input.title,
      description: input.description,
      excerpt,
      categoryId: input.categoryId,
      coverImageUrl: input.coverImageUrl ?? null,
      chunkCount: prepared.chunks.length,
      totalBytes: prepared.totalBytes,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: auth.uid,
      changeReason: "Original",
      basedOnRevisionId: null,
      restoredFromRevisionId: null,
    });
    if (input.idempotencyKey) {
      batch.create(idemRef(auth.uid, input.idempotencyKey), {
        workId,
        userId: auth.uid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    batch.set(statsRef(), statsIncrement({ totalWorks: 1 }), { merge: true });
    if (publish) applyPublishedDelta(batch, { categoryId: input.categoryId, authorId: auth.uid }, 1);
    await batch.commit();
  } catch (err) {
    // Roll back the staged content so no orphaned chunks remain.
    await deleteDocs(workChunks(workId), workChunkIds).catch(() => undefined);
    await deleteDocs(revisionChunks(workId, revisionId), revisionIds).catch(() => undefined);
    // A concurrent retry with the same idempotency key already created the work.
    if (input.idempotencyKey && isAlreadyExists(err)) {
      const prior = await idemRef(auth.uid, input.idempotencyKey).get();
      if (prior.exists) return getWorkDto(prior.get("workId") as string, auth);
    }
    throw err;
  }

  track({ eventId: `work-created:${workId}`, metric: "works_created" }, log);
  if (publish) track({ eventId: `work-published:${workId}:1`, metric: "works_published" }, log);
  return getWorkDto(workId, auth);
}

/* ---------------------------------- Lists ---------------------------------- */

const SORT_FIELD = {
  latest: "publishedAt",
  popular: "likeCount",
  viewed: "viewCount",
  discussed: "commentCount",
} as const;

export async function listPublicWorks(params: z.output<typeof listQuerySchema>, auth?: AuthContext | null) {
  const limit = clampLimit(params.limit, 12, 30);
  let query: Query = worksCol().where("status", "==", "published").where("visibility", "==", "public");

  const needle = params.q?.toLowerCase();
  if (needle && needle.length >= 2) {
    // Basic prefix search on the title. Richer search is a later phase.
    query = query
      .where("titleLower", ">=", needle)
      .where("titleLower", "<", `${needle}`)
      .orderBy("titleLower")
      .orderBy(docId());
    const { docs, nextCursor } = await runPage(query, {
      limit,
      cursor: params.cursor,
      cursorFields: (d) => [d.get("titleLower"), d.id],
    });
    return { items: await hydrateWorks(docs.map((d) => ({ id: d.id, ...d.data() }) as Doc), auth), nextCursor };
  }

  if (params.category) query = query.where("categoryId", "==", params.category);
  const field = SORT_FIELD[params.sort];
  query = query.orderBy(field, "desc").orderBy(docId(), "desc");
  const { docs, nextCursor } = await runPage(query, {
    limit,
    cursor: params.cursor,
    cursorFields: (d) => [d.get(field), d.id],
  });
  return { items: await hydrateWorks(docs.map((d) => ({ id: d.id, ...d.data() }) as Doc), auth), nextCursor };
}

export async function listMyWorks(
  auth: AuthContext,
  params: { status?: string; cursor?: string; limit?: string },
) {
  const limit = clampLimit(params.limit, 20, 50);
  let query: Query = worksCol().where("authorId", "==", auth.uid);
  if (params.status) query = query.where("status", "==", params.status);
  query = query.orderBy("updatedAt", "desc").orderBy(docId(), "desc");
  const { docs, nextCursor } = await runPage(query, {
    limit,
    cursor: params.cursor,
    cursorFields: (d) => [d.get("updatedAt"), d.id],
  });
  // Soft deleted works disappear from the author's normal lists.
  const works = docs.map((d) => ({ id: d.id, ...d.data() }) as Doc).filter((w) => w.status !== "deleted");
  return { items: await hydrateWorks(works, auth), nextCursor };
}

export async function listAuthorPublicWorks(
  authorId: string,
  params: { cursor?: string; limit: number },
  auth?: AuthContext | null,
) {
  const query = worksCol()
    .where("authorId", "==", authorId)
    .where("status", "==", "published")
    .where("visibility", "==", "public")
    .orderBy("publishedAt", "desc")
    .orderBy(docId(), "desc");
  const { docs, nextCursor } = await runPage(query, {
    limit: params.limit,
    cursor: params.cursor,
    cursorFields: (d) => [d.get("publishedAt"), d.id],
  });
  return { items: await hydrateWorks(docs.map((d) => ({ id: d.id, ...d.data() }) as Doc), auth), nextCursor };
}

/* ---------------------------------- Reading ---------------------------------- */

/**
 * Content is read separately from metadata, a few chunks at a time. The client passes back the
 * `revisionId` it was given, so if the author publishes an edit mid-read the reader is told to
 * reload instead of silently receiving a mix of two versions.
 */
export async function readWorkContent(
  workId: string,
  auth: AuthContext | null | undefined,
  opts: { after?: number; limit: number; revisionId?: string },
) {
  const work = await loadVisibleWork(workId, auth);
  const current = work.currentRevisionId as string;
  if (opts.revisionId && opts.revisionId !== current) {
    throw conflict("CONTENT_CHANGED", "This work was updated while you were reading. Reload to see the latest version.");
  }
  const page = await readChunks(workChunks(workId), `${current}_`, opts.after, opts.limit);
  return { revisionId: current, ...page };
}

/* ------------------------------ State transitions ------------------------------ */

export async function publishWork(auth: AuthContext, workId: string, log: Logger) {
  const settings = await settingsService.get();
  const work = await loadOwnWork(workId, auth);
  if (work.status === "published") return getWorkDto(workId, auth); // idempotent
  if (work.status === "flagged" || ["flagged", "underReview", "rejected"].includes(work.moderationStatus as string)) {
    throw conflict("WORK_FLAGGED", "This work was flagged by a moderator. Request a review instead of publishing.");
  }
  await assertPostingAllowed(auth.uid, work.categoryId as string, settings.defaultCategoryPostingAllowed);

  const publishCount = await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    const status = snap.get("status");
    if (!snap.exists || status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    if (status === "flagged") throw conflict("WORK_FLAGGED", "This work was flagged by a moderator.");
    const count = ((snap.get("publishCount") as number | undefined) ?? 0) + 1;
    if (status === "published") return null;
    tx.update(workRef(workId), {
      status: "published",
      publishCount: count,
      publishedAt: snap.get("publishedAt") ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    applyPublishedDelta(tx, { categoryId: snap.get("categoryId"), authorId: snap.get("authorId") }, 1);
    return count;
  });

  if (publishCount !== null) {
    track({ eventId: `work-published:${workId}:${publishCount}`, metric: "works_published" }, log);
  }
  return getWorkDto(workId, auth);
}

/** Takes a published work out of public view without deleting it. */
export async function archiveWork(auth: AuthContext, workId: string) {
  await loadOwnWork(workId, auth);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    if (snap.get("status") !== "published") return;
    tx.update(workRef(workId), { status: "archived", updatedAt: FieldValue.serverTimestamp() });
    applyPublishedDelta(tx, { categoryId: snap.get("categoryId"), authorId: snap.get("authorId") }, -1);
  });
  return getWorkDto(workId, auth);
}

export async function setVisibility(auth: AuthContext, workId: string, visibility: "public" | "private") {
  await loadOwnWork(workId, auth);
  await workRef(workId).update({ visibility, updatedAt: FieldValue.serverTimestamp() });
  return getWorkDto(workId, auth);
}

/** Soft delete: the work vanishes from normal queries but can be restored by administrators. */
export async function softDeleteWork(auth: AuthContext, workId: string, log: Logger) {
  const existing = await getWork(workId);
  if (!existing || existing.status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  const isAuthor = existing.authorId === auth.uid;
  if (!isAuthor && !auth.permissions.deleteWorks) {
    throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    if (!snap.exists || snap.get("status") === "deleted") return;
    const t = softDeleteTransition({
      status: snap.get("status"),
      moderationStatus: snap.get("moderationStatus"),
    });
    if (t.noop) return;
    tx.update(workRef(workId), {
      status: t.status,
      moderationStatus: t.moderationStatus,
      statusBeforeDelete: snap.get("status"),
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: auth.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (t.cancelReview) {
      // A deleted work cannot be reviewed, so the open request is closed.
      const reviewId = snap.get("moderation.reviewId") as string | undefined;
      if (reviewId) tx.update(reviewsCol().doc(reviewId), { status: "cancelled", resolvedAt: FieldValue.serverTimestamp() });
    }
    tx.set(statsRef(), statsIncrement(t.counters), { merge: true });
    if (t.publishedDelta !== 0) {
      applyPublishedDelta(tx, { categoryId: snap.get("categoryId"), authorId: snap.get("authorId") }, t.publishedDelta);
    }
  });

  const reason = isAuthor ? "Deleted by author" : "Deleted by moderator";
  await logModeration(
    { workId, userId: existing.authorId as string, moderatorId: auth.uid, actorRole: auth.profile.role, action: "DELETE", reason },
    log,
  );
  if (!isAuthor) {
    await logAdmin({ adminId: auth.uid, action: "WORK_DELETED", targetType: "work", targetId: workId, metadata: { authorId: existing.authorId } }, log);
  }
}

/** Used by the editor to read the autosaved or original source of a work you authored. */
export async function assertDraftChunksExist(workId: string) {
  const first = await draftChunks(workId).limit(1).get();
  if (first.empty) throw badRequest("DRAFT_NOT_FOUND", "There is no autosaved draft.");
}
