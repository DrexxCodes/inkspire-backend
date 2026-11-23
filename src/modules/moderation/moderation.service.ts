import type { PoolClient } from "pg";
import { pool, query, withTransaction } from "../../config/postgres.js";
import type { AuthContext } from "../../types/domain.js";
import { getRevision, getWork, hydrateWorks, lockWork, type WorkRecord } from "../../repositories/works.repo.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { clampLimit, decodeKey, keysetClause, sliceKeyset } from "../../utils/pagination.js";
import { logAdmin, logModeration, type ModerationAction } from "../../services/audit.service.js";
import { notify } from "../../services/notifications.service.js";
import { track } from "../../services/analytics.service.js";
import { activateRevisionIn } from "../revisions/revisions.service.js";
import {
  approve as approveT,
  flag as flagT,
  reject as rejectT,
  requestReview as requestReviewT,
  restoreDeleted as restoreT,
  unflag as unflagT,
  type WorkState,
} from "./moderation.rules.js";

type Logger = Parameters<typeof logAdmin>[1] & Parameters<typeof track>[1];

const stateOf = (w: WorkRecord): WorkState => ({
  status: w.status,
  moderationStatus: w.moderationStatus ?? "clean",
  statusBeforeFlag: w.statusBeforeFlag,
  statusBeforeDelete: w.statusBeforeDelete,
});

const requireReason = (reason: string | undefined) => {
  const r = reason?.trim();
  if (!r) throw badRequest("REASON_REQUIRED", "A reason is required for this action.");
  return r;
};

async function lockOrThrow(c: PoolClient, workId: string): Promise<WorkRecord> {
  const w = await lockWork(c, workId);
  if (!w) throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  return w;
}

async function record(
  actor: AuthContext,
  work: WorkRecord,
  action: ModerationAction,
  adminAction: Parameters<typeof logAdmin>[0]["action"] | null,
  reason: string | null,
  revisionId: string | null,
  log: Logger,
) {
  await logModeration(
    { workId: work.id, userId: work.authorId, moderatorId: actor.uid, actorRole: actor.profile.role, action, reason, revisionId },
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

  const result = await withTransaction(async (c) => {
    const cur = await lockOrThrow(c, workId);
    const t = flagT(stateOf(cur));
    if (t.noop) return { changed: false };
    const moderation = {
      status: "flagged",
      reason,
      flaggedBy: actor.uid,
      flaggedAt: new Date().toISOString(),
      flaggedRevisionNumber: cur.lastRevisionNumber ?? 0,
      reviewId: null,
    };
    await c.query(
      `UPDATE works SET status = $2, moderation_status = $3, status_before_flag = $4, moderation = $5::jsonb, updated_at = inkspire_now()
        WHERE id = $1`,
      [workId, t.status, t.moderationStatus, cur.status, JSON.stringify(moderation)],
    );
    return { changed: true };
  });

  if (result.changed) {
    await record(actor, work, "FLAG", "WORK_FLAGGED", reason, null, log);
    await notify(work.authorId, { type: "WORK_FLAGGED", title: "Your work was flagged", body: `${work.title}: ${reason}`, workId }, log);
  }
  return { changed: result.changed };
}

export async function unflagWork(actor: AuthContext, workId: string, reasonInput: string | undefined, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  await withTransaction(async (c) => {
    const cur = await lockOrThrow(c, workId);
    const t = unflagT(stateOf(cur));
    const reviewId = (cur.moderation?.reviewId as string | undefined) ?? undefined;
    await c.query(
      `UPDATE works SET status = $2, moderation_status = $3, moderation = NULL, updated_at = inkspire_now() WHERE id = $1`,
      [workId, t.status, t.moderationStatus],
    );
    if (t.cancelReview && reviewId) {
      await c.query(`UPDATE work_review_requests SET status = 'cancelled', resolved_at = inkspire_now() WHERE id = $1`, [reviewId]);
    }
  });

  await record(actor, work, "UNFLAG", "WORK_UNFLAGGED", reasonInput?.trim() || null, null, log);
  await notify(work.authorId, { type: "WORK_UNFLAGGED", title: "The flag on your work was removed", body: work.title, workId }, log);
}

/* ------------------------------- Request a review ------------------------------- */

export async function requestReview(actor: AuthContext, workId: string, revisionId: string, log: Logger) {
  const work = await getWork(workId);
  // Same answer for "missing" and "not yours".
  if (!work || work.authorId !== actor.uid || work.status === "deleted") {
    throw notFound("WORK_NOT_FOUND", "That work does not exist.");
  }
  const rev = await getRevision(workId, revisionId);
  if (!rev) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");

  const flaggedAt = (work.moderation?.flaggedRevisionNumber as number | undefined) ?? 0;
  if (rev.revisionNumber <= flaggedAt) {
    throw badRequest("REVISION_NOT_REVISED", "Revise your work before requesting another review.");
  }

  const reviewId = `${workId}_${revisionId}`;
  const outcome = await withTransaction(async (c) => {
    const cur = await lockOrThrow(c, workId);
    const t = requestReviewT(stateOf(cur));
    const existing = await c.query(`SELECT status FROM work_review_requests WHERE id = $1 FOR UPDATE`, [reviewId]);
    if (t.noop) {
      // A retry or a second click. If it is for the same revision this is simply success.
      if (existing.rows[0]?.status === "pending") return { reviewId, created: false };
      throw conflict("REVIEW_ALREADY_PENDING", "A review of a different revision is already pending.");
    }
    await c.query(
      `INSERT INTO work_review_requests (id, work_id, revision_id, author_id, requested_by, status)
       VALUES ($1, $2, $3, $4, $4, 'pending')
       ON CONFLICT (id) DO UPDATE SET status = 'pending', requested_at = inkspire_now(), resolved_at = NULL,
         resolved_by = NULL, reason = NULL, turnaround_ms = NULL`,
      [reviewId, workId, revisionId, actor.uid],
    );
    await c.query(
      `UPDATE works SET moderation_status = $2,
              moderation = jsonb_set(jsonb_set(COALESCE(moderation, '{}'::jsonb), '{status}', '"underReview"'), '{reviewId}', to_jsonb($3::text)),
              updated_at = inkspire_now()
        WHERE id = $1`,
      [workId, t.moderationStatus, reviewId],
    );
    return { reviewId, created: true };
  });

  if (outcome.created) {
    await logModeration(
      { workId, userId: actor.uid, moderatorId: actor.uid, actorRole: actor.profile.role, action: "REQUEST_REVIEW", reason: null, revisionId },
      log,
    );
    await notify(actor.uid, { type: "REVIEW_RECEIVED", title: "Your review request was received", body: work.title, workId }, log);
  }
  return outcome;
}

/* ---------------------------------- Decisions ---------------------------------- */

async function pendingReviewFor(c: PoolClient, cur: WorkRecord) {
  const reviewId = cur.moderation?.reviewId as string | undefined;
  if (!reviewId) throw conflict("NOT_UNDER_REVIEW", "This work has no pending review.");
  const res = await c.query(`SELECT * FROM work_review_requests WHERE id = $1 FOR UPDATE`, [reviewId]);
  const r = res.rows[0];
  if (!r || r.status !== "pending") throw conflict("NOT_UNDER_REVIEW", "This work has no pending review.");
  return { id: r.id as string, revisionId: r.revision_id as string, requestedAt: new Date(r.requested_at) };
}

export async function approveWork(actor: AuthContext, workId: string, note: string | undefined, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  // One transaction: the reviewed revision goes live and the work is published together, or neither happens.
  const outcome = await withTransaction(async (c) => {
    const cur = await lockOrThrow(c, workId);
    const review = await pendingReviewFor(c, cur);
    const t = approveT(stateOf(cur));
    if (cur.currentRevisionId !== review.revisionId) await activateRevisionIn(c, workId, review.revisionId);
    const moderation = { status: "approved", reviewedBy: actor.uid, reviewedAt: new Date().toISOString(), note: note?.trim() || null };
    const upd = await c.query(
      `UPDATE works SET status = $2, moderation_status = $3, moderation = $4::jsonb, publish_count = publish_count + 1,
              published_at = COALESCE(published_at, inkspire_now()), updated_at = inkspire_now()
        WHERE id = $1 RETURNING publish_count`,
      [workId, t.status, t.moderationStatus, JSON.stringify(moderation)],
    );
    await c.query(
      `UPDATE work_review_requests SET status = 'approved', resolved_by = $2, resolved_at = inkspire_now(), turnaround_ms = $3 WHERE id = $1`,
      [review.id, actor.uid, Date.now() - review.requestedAt.getTime()],
    );
    return { revisionId: review.revisionId, published: upd.rows[0].publish_count as number };
  });

  await record(actor, work, "APPROVE", "WORK_APPROVED", note?.trim() || null, outcome.revisionId, log);
  track({ eventId: `work-published:${workId}:${outcome.published}`, metric: "works_published" }, log);
  await notify(work.authorId, { type: "WORK_APPROVED", title: "Your work has been approved", body: work.title, workId }, log);
}

export async function rejectWork(actor: AuthContext, workId: string, reasonInput: string | undefined, log: Logger) {
  const reason = requireReason(reasonInput);
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  const revisionId = await withTransaction(async (c) => {
    const cur = await lockOrThrow(c, workId);
    const review = await pendingReviewFor(c, cur);
    const t = rejectT(stateOf(cur));
    const prev = cur.moderation ?? {};
    const moderation = {
      status: "rejected",
      reason,
      flaggedBy: prev.flaggedBy ?? null,
      flaggedAt: prev.flaggedAt ?? null,
      flaggedRevisionNumber: prev.flaggedRevisionNumber ?? 0,
      reviewedBy: actor.uid,
      reviewedAt: new Date().toISOString(),
      reviewId: null,
    };
    await c.query(
      `UPDATE works SET moderation_status = $2, moderation = $3::jsonb, updated_at = inkspire_now() WHERE id = $1`,
      [workId, t.moderationStatus, JSON.stringify(moderation)],
    );
    await c.query(
      `UPDATE work_review_requests SET status = 'rejected', reason = $2, resolved_by = $3, resolved_at = inkspire_now(), turnaround_ms = $4 WHERE id = $1`,
      [review.id, reason, actor.uid, Date.now() - review.requestedAt.getTime()],
    );
    return review.revisionId;
  });

  await record(actor, work, "REJECT", "WORK_REJECTED", reason, revisionId, log);
  await notify(work.authorId, { type: "WORK_REJECTED", title: "Your work was rejected", body: `${work.title}: ${reason}`, workId }, log);
}

/* ------------------------------ Restore / permanent ------------------------------ */

export async function restoreWork(actor: AuthContext, workId: string, log: Logger) {
  const work = await getWork(workId);
  if (!work) throw notFound("WORK_NOT_FOUND", "That work does not exist.");

  await withTransaction(async (c) => {
    const cur = await lockOrThrow(c, workId);
    const t = restoreT(stateOf(cur));
    await c.query(
      `UPDATE works SET status = $2, deleted_at = NULL, deleted_by = NULL, status_before_delete = NULL, updated_at = inkspire_now() WHERE id = $1`,
      [workId, t.status],
    );
  });

  await record(actor, work, "RESTORE", "WORK_RESTORED", null, null, log);
}

/* ------------------------------------ Queue ------------------------------------ */

export async function listPendingReviews(params: { cursor?: string; limit?: string }) {
  const limit = clampLimit(params.limit, 20, 50);
  const values: unknown[] = [];
  const where = [`status = 'pending'`];
  const after = keysetClause(["requested_at", "id"], ["ts", "text"], "asc", decodeKey(params.cursor, ["ts", "text"]), values);
  if (after) where.push(after);
  values.push(limit + 1);
  const res = await pool.query(
    `SELECT * FROM work_review_requests WHERE ${where.join(" AND ")} ORDER BY requested_at ASC, id ASC LIMIT $${values.length}`,
    values,
  );
  const page = sliceKeyset(res.rows, limit, (r) => [r.requested_at, r.id]);
  const works = (await Promise.all(page.rows.map((r) => getWork(r.work_id as string)))).filter(Boolean) as WorkRecord[];
  const dtos = await hydrateWorks(works);
  const byId = new Map(dtos.map((w) => [w.id, w]));
  const items = page.rows
    .map((r) => ({ reviewId: r.id, revisionId: r.revision_id, requestedAt: r.requested_at, work: byId.get(r.work_id) }))
    .filter((i) => i.work);
  return { items: serialize(items), nextCursor: page.nextCursor };
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
