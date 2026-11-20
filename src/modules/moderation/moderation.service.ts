import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase.js";
import type { AuthContext, Doc } from "../../types/domain.js";
import { getWork, hydrateWorks, revisionRef, reviewsCol, workRef } from "../../repositories/works.repo.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { clampLimit, runPage } from "../../utils/pagination.js";
import { applyPublishedDelta, statsIncrement, statsRef } from "../../services/stats.service.js";
import { logAdmin, logModeration, type ModerationAction } from "../../services/audit.service.js";
import { notify } from "../../services/notifications.service.js";
import { track } from "../../services/analytics.service.js";
import { query } from "../../config/postgres.js";
import { activateRevision } from "../revisions/revisions.service.js";
import {
  approve as approveT,
  flag as flagT,
  reject as rejectT,
  requestReview as requestReviewT,
  restoreDeleted as restoreT,
  unflag as unflagT,
  type Transition,
  type WorkState,
} from "./moderation.rules.js";

type Logger = Parameters<typeof logAdmin>[1] & Parameters<typeof track>[1];

const stateOf = (snap: FirebaseFirestore.DocumentSnapshot): WorkState => ({
  status: snap.get("status"),
  moderationStatus: snap.get("moderationStatus") ?? "clean",
  statusBeforeFlag: snap.get("statusBeforeFlag") ?? null,
  statusBeforeDelete: snap.get("statusBeforeDelete") ?? null,
});

function applyCounters(tx: FirebaseFirestore.Transaction, snap: FirebaseFirestore.DocumentSnapshot, t: Transition) {
  if (Object.keys(t.counters).length) tx.set(statsRef(), statsIncrement(t.counters), { merge: true });
  if (t.publishedDelta !== 0) {
    applyPublishedDelta(tx, { categoryId: snap.get("categoryId"), authorId: snap.get("authorId") }, t.publishedDelta);
  }
}

const requireReason = (reason: string | undefined) => {
  const r = reason?.trim();
  if (!r) throw badRequest("REASON_REQUIRED", "A reason is required for this action.");
  return r;
};

async function record(
  actor: AuthContext,
  work: Doc,
  action: ModerationAction,
  adminAction: Parameters<typeof logAdmin>[0]["action"] | null,
  reason: string | null,
  revisionId: string | null,
  log: Logger,
) {
  await logModeration(
    { workId: work.id, userId: work.authorId as string, moderatorId: actor.uid, actorRole: actor.profile.role, action, reason, revisionId },
    log,
  );
  if (adminAction) {
    await logAdmin({ adminId: actor.uid, action: adminAction, targetType: "work", targetId: work.id, metadata: { reason, revisionId } }, log);
  }
}

/* --------------------------------- Flag / unflag --------------------------------- */

export async function flagWork(actor: AuthContext, workId: string, reasonInput: string | undefined, log: Logger) {
  const reason = requireReason(reasonInput);
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    const t = flagT(stateOf(snap));
    if (t.noop) return { changed: false };
    tx.update(workRef(workId), {
      status: t.status,
      moderationStatus: t.moderationStatus,
      statusBeforeFlag: snap.get("status"),
      moderation: {
        status: "flagged",
        reason,
        flaggedBy: actor.uid,
        flaggedAt: FieldValue.serverTimestamp(),
        flaggedRevisionNumber: snap.get("lastRevisionNumber") ?? 0,
        reviewId: null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    applyCounters(tx, snap, t);
    return { changed: true };
  });

  if (result.changed) {
    await record(actor, work, "FLAG", "WORK_FLAGGED", reason, null, log);
    await notify(
      work.authorId as string,
      { type: "WORK_FLAGGED", title: "Your work was flagged", body: `${work.title}: ${reason}`, workId },
      log,
    );
  }
  return { changed: result.changed };
}

export async function unflagWork(actor: AuthContext, workId: string, reasonInput: string | undefined, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    const t = unflagT(stateOf(snap));
    tx.update(workRef(workId), {
      status: t.status,
      moderationStatus: t.moderationStatus,
      moderation: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const reviewId = snap.get("moderation.reviewId") as string | undefined;
    if (t.cancelReview && reviewId) {
      tx.update(reviewsCol().doc(reviewId), { status: "cancelled", resolvedAt: FieldValue.serverTimestamp() });
    }
    applyCounters(tx, snap, t);
  });

  await record(actor, work, "UNFLAG", "WORK_UNFLAGGED", reasonInput?.trim() || null, null, log);
  await notify(work.authorId as string, { type: "WORK_UNFLAGGED", title: "The flag on your work was removed", body: work.title as string, workId }, log);
}

/* ------------------------------- Request a review ------------------------------- */

export async function requestReview(actor: AuthContext, workId: string, revisionId: string, log: Logger) {
  const work = await getWork(workId);
  // Same answer for "missing" and "not yours".
  if (!work || work.authorId !== actor.uid || work.status === "deleted") {
    throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  }
  const rev = await revisionRef(workId, revisionId).get();
  if (!rev.exists) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");

  const flaggedAt = (work.moderation?.flaggedRevisionNumber as number | undefined) ?? 0;
  if ((rev.get("revisionNumber") as number) <= flaggedAt) {
    throw badRequest("REVISION_NOT_REVISED", "Revise your work before requesting another review.");
  }

  const reviewRef = reviewsCol().doc(`${workId}_${revisionId}`);
  const outcome = await db.runTransaction(async (tx) => {
    const [snap, existing] = await Promise.all([tx.get(workRef(workId)), tx.get(reviewRef)]);
    const t = requestReviewT(stateOf(snap));
    if (t.noop) {
      // A retry or a second click. If it is for the same revision this is simply success.
      if (existing.exists && existing.get("status") === "pending") return { reviewId: reviewRef.id, created: false };
      throw conflict("REVIEW_ALREADY_PENDING", "A review of a different revision is already pending.");
    }
    tx.set(reviewRef, {
      workId,
      revisionId,
      authorId: actor.uid,
      requestedBy: actor.uid,
      requestedAt: FieldValue.serverTimestamp(),
      status: "pending",
    });
    tx.update(workRef(workId), {
      moderationStatus: t.moderationStatus,
      "moderation.status": "underReview",
      "moderation.reviewId": reviewRef.id,
      updatedAt: FieldValue.serverTimestamp(),
    });
    applyCounters(tx, snap, t);
    return { reviewId: reviewRef.id, created: true };
  });

  if (outcome.created) {
    await logModeration(
      { workId, userId: actor.uid, moderatorId: actor.uid, actorRole: actor.profile.role, action: "REQUEST_REVIEW", reason: null, revisionId },
      log,
    );
    await notify(actor.uid, { type: "REVIEW_RECEIVED", title: "Your review request was received", body: work.title as string, workId }, log);
  }
  return outcome;
}

/* ---------------------------------- Decisions ---------------------------------- */

async function pendingReviewFor(workId: string, work: Doc) {
  const reviewId = work.moderation?.reviewId as string | undefined;
  if (!reviewId) throw conflict("NOT_UNDER_REVIEW", "This work has no pending review.");
  const snap = await reviewsCol().doc(reviewId).get();
  if (!snap.exists || snap.get("status") !== "pending") throw conflict("NOT_UNDER_REVIEW", "This work has no pending review.");
  return { id: snap.id, revisionId: snap.get("revisionId") as string, requestedAt: snap.get("requestedAt") as FirebaseFirestore.Timestamp };
}

export async function approveWork(actor: AuthContext, workId: string, note: string | undefined, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  const review = await pendingReviewFor(workId, work);

  // Make the reviewed revision the live content first (pointer-last, so a failure here changes nothing).
  if (work.currentRevisionId !== review.revisionId) {
    const rev = await revisionRef(workId, review.revisionId).get();
    await activateRevision(
      workId,
      review.revisionId,
      {
        title: rev.get("title"),
        description: rev.get("description") ?? "",
        excerpt: rev.get("excerpt") ?? "",
        categoryId: rev.get("categoryId"),
        coverImageUrl: rev.get("coverImageUrl") ?? null,
        chunkCount: rev.get("chunkCount"),
        totalBytes: rev.get("totalBytes"),
      },
      log,
    );
  }

  const published = await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    const t = approveT(stateOf(snap));
    tx.update(workRef(workId), {
      status: t.status,
      moderationStatus: t.moderationStatus,
      moderation: { status: "approved", reviewedBy: actor.uid, reviewedAt: FieldValue.serverTimestamp(), note: note?.trim() || null },
      publishCount: FieldValue.increment(1),
      publishedAt: snap.get("publishedAt") ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(reviewsCol().doc(review.id), {
      status: "approved",
      resolvedBy: actor.uid,
      resolvedAt: FieldValue.serverTimestamp(),
      turnaroundMs: Date.now() - review.requestedAt.toMillis(),
    });
    applyCounters(tx, snap, t);
    return ((snap.get("publishCount") as number | undefined) ?? 0) + 1;
  });

  await record(actor, work, "APPROVE", "WORK_APPROVED", note?.trim() || null, review.revisionId, log);
  track({ eventId: `work-published:${workId}:${published}`, metric: "works_published" }, log);
  await notify(work.authorId as string, { type: "WORK_APPROVED", title: "Your work has been approved", body: work.title as string, workId }, log);
}

export async function rejectWork(actor: AuthContext, workId: string, reasonInput: string | undefined, log: Logger) {
  const reason = requireReason(reasonInput);
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  const review = await pendingReviewFor(workId, work);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    const t = rejectT(stateOf(snap));
    tx.update(workRef(workId), {
      moderationStatus: t.moderationStatus,
      moderation: {
        status: "rejected",
        reason,
        flaggedBy: snap.get("moderation.flaggedBy") ?? null,
        flaggedAt: snap.get("moderation.flaggedAt") ?? null,
        flaggedRevisionNumber: snap.get("moderation.flaggedRevisionNumber") ?? 0,
        reviewedBy: actor.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewId: null,
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.update(reviewsCol().doc(review.id), {
      status: "rejected",
      reason,
      resolvedBy: actor.uid,
      resolvedAt: FieldValue.serverTimestamp(),
      turnaroundMs: Date.now() - review.requestedAt.toMillis(),
    });
    applyCounters(tx, snap, t);
  });

  await record(actor, work, "REJECT", "WORK_REJECTED", reason, review.revisionId, log);
  await notify(work.authorId as string, { type: "WORK_REJECTED", title: "Your work was rejected", body: `${work.title}: ${reason}`, workId }, log);
}

/* ------------------------------ Restore / permanent ------------------------------ */

export async function restoreWork(actor: AuthContext, workId: string, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    const t = restoreT(stateOf(snap));
    tx.update(workRef(workId), {
      status: t.status,
      deletedAt: null,
      deletedBy: null,
      statusBeforeDelete: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    applyCounters(tx, snap, t);
  });

  await record(actor, work, "RESTORE", "WORK_RESTORED", null, null, log);
}

/* ------------------------------------ Queue ------------------------------------ */

export async function listPendingReviews(params: { cursor?: string; limit?: string }) {
  const { docs, nextCursor } = await runPage(reviewsCol().where("status", "==", "pending").orderBy("requestedAt", "asc"), {
    limit: clampLimit(params.limit, 20, 50),
    cursor: params.cursor,
    cursorFields: (d) => [d.get("requestedAt")],
  });
  const works = (await Promise.all(docs.map((d) => getWork(d.get("workId") as string)))).filter(Boolean) as Doc[];
  const dtos = await hydrateWorks(works);
  const byId = new Map(dtos.map((w) => [w.id, w]));
  const items = docs
    .map((d) => ({ reviewId: d.id, revisionId: d.get("revisionId"), requestedAt: d.get("requestedAt"), work: byId.get(d.get("workId")) }))
    .filter((i) => i.work);
  return { items: serialize(items), nextCursor };
}

export async function moderationHistory(filter: { workId?: string; userId?: string }, limit: number, before?: string) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.workId) { params.push(filter.workId); where.push(`work_id = $${params.length}`); }
  if (filter.userId) { params.push(filter.userId); where.push(`user_id = $${params.length}`); }
  if (before) { params.push(before); where.push(`created_at < $${params.length}`); }
  params.push(limit + 1);
  const res = await query(
    `SELECT id, work_id, user_id, moderator_id, actor_role, action, reason, revision_id, created_at
       FROM moderation_actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  const rows = res.rows.slice(0, limit);
  const next = res.rows.length > limit ? new Date(rows[rows.length - 1]!.created_at).toISOString() : null;
  return { items: rows, nextCursor: next };
}
