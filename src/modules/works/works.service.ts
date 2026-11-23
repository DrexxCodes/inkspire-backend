import { z } from "zod";
import { pool, withTransaction } from "../../config/postgres.js";
import type { AuthContext } from "../../types/domain.js";
import {
  WORK_SELECT,
  getWork,
  hasLiked,
  hydrateWorks,
  listWorkRows,
  lockWork,
} from "../../repositories/works.repo.js";
import { conflict, notFound } from "../../utils/errors.js";
import { makeExcerpt } from "../../utils/text.js";
import { escapeLike, newId } from "../../utils/ids.js";
import { clampLimit, decodeKey, keysetClause, sliceKeyset, type KeyType } from "../../utils/pagination.js";
import { insertRevisionChunks, prepareContent, readRevisionChunks } from "../../services/content.service.js";
import { settingsService } from "../../services/settings.service.js";
import { track } from "../../services/analytics.service.js";
import { logAdmin, logModeration } from "../../services/audit.service.js";
import { softDelete as softDeleteTransition } from "../moderation/moderation.rules.js";
import { assertCanEnterPrompt, lockEntrySlot } from "../prompts/prompts.guards.js";
import { assertPostingAllowed, loadOwnWork, loadVisibleWork } from "./works.guards.js";
import { createWorkSchema, listQuerySchema } from "./works.schemas.js";

type Logger = Parameters<typeof track>[1] & Parameters<typeof logAdmin>[1];

class DuplicateRequest extends Error {}

export async function getWorkDto(workId: string, auth?: AuthContext | null) {
  const work = await loadVisibleWork(workId, auth);
  const [dto] = await hydrateWorks([work], auth);
  const liked = auth ? await hasLiked(workId, auth.uid) : false;
  return { ...dto!, viewer: { isAuthor: auth?.uid === work.authorId, liked } };
}

async function findIdempotent(uid: string, key: string): Promise<string | null> {
  const res = await pool.query(`SELECT work_id FROM work_idempotency WHERE user_id = $1 AND idem_key = $2`, [uid, key]);
  return res.rows[0]?.work_id ?? null;
}

/* ---------------------------------- Create ---------------------------------- */

/**
 * Posting, in one transaction: the work, its first revision and that revision's text chunks, and
 * the idempotency marker. Either all of it exists or none of it does, so there are no orphaned
 * chunks to clean up and nothing half written is ever visible.
 */
export async function createWork(auth: AuthContext, input: z.output<typeof createWorkSchema>, log: Logger) {
  const settings = await settingsService.get();

  if (input.idempotencyKey) {
    const prior = await findIdempotent(auth.uid, input.idempotencyKey);
    if (prior) return getWorkDto(prior, auth);
  }

  await assertPostingAllowed(auth.uid, input.categoryId, settings.defaultCategoryPostingAllowed);
  const prepared = prepareContent(input.content, {
    thresholdBytes: settings.contentChunkThresholdBytes,
    maxWorkSizeBytes: settings.maxWorkSizeBytes,
  });

  const workId = newId();
  const revisionId = "r1";
  const excerpt = makeExcerpt(input.content);
  const publish = input.publish;

  try {
    await withTransaction(async (c) => {
      if (input.promptId) {
        await lockEntrySlot(c, input.promptId, auth.uid);
        await assertCanEnterPrompt(c, { promptId: input.promptId, userId: auth.uid, categoryId: input.categoryId });
      }
      await c.query(
        `INSERT INTO works (id, author_id, title, description, excerpt, category_id, prompt_id, cover_image_url,
                            status, visibility, chunk_count, total_bytes, current_revision_id, last_revision_number,
                            publish_count, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, CASE WHEN $15 THEN inkspire_now() END)`,
        [
          workId, auth.uid, input.title, input.description, excerpt, input.categoryId, input.promptId ?? null,
          input.coverImageUrl ?? null, publish ? "published" : "draft", input.visibility,
          prepared.chunks.length, prepared.totalBytes, revisionId, publish ? 1 : 0, publish,
        ],
      );
      await c.query(
        `INSERT INTO work_revisions (work_id, id, revision_number, title, description, excerpt, category_id,
                                     cover_image_url, chunk_count, total_bytes, created_by, change_reason)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, 'Original')`,
        [workId, revisionId, input.title, input.description, excerpt, input.categoryId, input.coverImageUrl ?? null,
          prepared.chunks.length, prepared.totalBytes, auth.uid],
      );
      await insertRevisionChunks(c, workId, revisionId, prepared.chunks);
      if (input.idempotencyKey) {
        const marker = await c.query(
          `INSERT INTO work_idempotency (user_id, idem_key, work_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [auth.uid, input.idempotencyKey, workId],
        );
        // A concurrent retry with the same key won the race. Undo this attempt and return theirs.
        if (marker.rowCount === 0) throw new DuplicateRequest();
      }
    });
  } catch (err) {
    if (err instanceof DuplicateRequest && input.idempotencyKey) {
      const prior = await findIdempotent(auth.uid, input.idempotencyKey);
      if (prior) return getWorkDto(prior, auth);
    }
    throw err;
  }

  track({ eventId: `work-created:${workId}`, metric: "works_created" }, log);
  if (publish) track({ eventId: `work-published:${workId}:1`, metric: "works_published" }, log);
  return getWorkDto(workId, auth);
}

/* ---------------------------------- Lists ---------------------------------- */

const SORT = {
  latest: { expr: "w.published_at", type: "ts" },
  popular: { expr: "w.like_count", type: "int" },
  viewed: { expr: "w.view_count", type: "int" },
  discussed: { expr: "w.comment_count", type: "int" },
} as const satisfies Record<string, { expr: string; type: KeyType }>;

export async function listPublicWorks(params: z.output<typeof listQuerySchema>, auth?: AuthContext | null) {
  const limit = clampLimit(params.limit, 12, 30);
  const values: unknown[] = [];
  const where = [`w.status = 'published'`, `w.visibility = 'public'`];
  if (params.category) {
    values.push(params.category);
    where.push(`w.category_id = $${values.length}`);
  }
  if (params.prompt) {
    values.push(params.prompt);
    where.push(`w.prompt_id = $${values.length}`);
  }

  let exprs: string[];
  let types: KeyType[];
  let dir: "asc" | "desc";
  let order: string;
  const needle = params.q?.toLowerCase();
  if (needle && needle.length >= 2) {
    // Prefix search on the title, ordered alphabetically. Richer search is a later phase.
    values.push(`${escapeLike(needle)}%`);
    where.push(`w.title_lower LIKE $${values.length}`);
    exprs = ["w.title_lower", "w.id"];
    types = ["text", "text"];
    dir = "asc";
    order = "w.title_lower ASC, w.id ASC";
  } else {
    const s = SORT[params.sort];
    exprs = [s.expr, "w.id"];
    types = [s.type, "text"];
    dir = "desc";
    order = `${s.expr} DESC, w.id DESC`;
  }
  const after = keysetClause(exprs, types, dir, decodeKey(params.cursor, types), values);
  if (after) where.push(after);
  values.push(limit + 1);

  const rows = await listWorkRows(`${WORK_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${values.length}`, values);
  const page = sliceKeyset(rows, limit, (w) =>
    needle && needle.length >= 2
      ? [w.title.toLowerCase(), w.id]
      : [params.sort === "latest" ? w.publishedAt : params.sort === "popular" ? w.likeCount : params.sort === "viewed" ? w.viewCount : w.commentCount, w.id],
  );
  return { items: await hydrateWorks(page.rows, auth), nextCursor: page.nextCursor };
}

export async function listMyWorks(
  auth: AuthContext,
  params: { status?: string; cursor?: string; limit?: string },
) {
  const limit = clampLimit(params.limit, 20, 50);
  const types: KeyType[] = ["ts", "text"];
  // Soft deleted works disappear from the author's normal lists.
  const values: unknown[] = [auth.uid];
  const where = [`w.author_id = $1`, `w.status <> 'deleted'`];
  if (params.status) {
    values.push(params.status);
    where.push(`w.status = $${values.length}`);
  }
  const after = keysetClause(["w.updated_at", "w.id"], types, "desc", decodeKey(params.cursor, types), values);
  if (after) where.push(after);
  values.push(limit + 1);
  const rows = await listWorkRows(
    `${WORK_SELECT} WHERE ${where.join(" AND ")} ORDER BY w.updated_at DESC, w.id DESC LIMIT $${values.length}`,
    values,
  );
  const page = sliceKeyset(rows, limit, (w) => [w.updatedAt, w.id]);
  return { items: await hydrateWorks(page.rows, auth), nextCursor: page.nextCursor };
}

export async function listAuthorPublicWorks(
  authorId: string,
  params: { cursor?: string; limit: number },
  auth?: AuthContext | null,
) {
  const types: KeyType[] = ["ts", "text"];
  const values: unknown[] = [authorId];
  const where = [`w.author_id = $1`, `w.status = 'published'`, `w.visibility = 'public'`];
  const after = keysetClause(["w.published_at", "w.id"], types, "desc", decodeKey(params.cursor, types), values);
  if (after) where.push(after);
  values.push(params.limit + 1);
  const rows = await listWorkRows(
    `${WORK_SELECT} WHERE ${where.join(" AND ")} ORDER BY w.published_at DESC, w.id DESC LIMIT $${values.length}`,
    values,
  );
  const page = sliceKeyset(rows, params.limit, (w) => [w.publishedAt, w.id]);
  return { items: await hydrateWorks(page.rows, auth), nextCursor: page.nextCursor };
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
  const current = work.currentRevisionId;
  if (opts.revisionId && opts.revisionId !== current) {
    throw conflict("CONTENT_CHANGED", "This work was updated while you were reading. Reload to see the latest version.");
  }
  const page = await readRevisionChunks(workId, current, opts.after, opts.limit);
  return { revisionId: current, ...page };
}

/* ------------------------------ State transitions ------------------------------ */

export async function publishWork(auth: AuthContext, workId: string, log: Logger) {
  const settings = await settingsService.get();
  const work = await loadOwnWork(workId, auth);
  if (work.status === "published") return getWorkDto(workId, auth); // idempotent
  if (work.status === "flagged" || ["flagged", "underReview", "rejected"].includes(work.moderationStatus)) {
    throw conflict("WORK_FLAGGED", "This work was flagged by a moderator. Request a review instead of publishing.");
  }
  await assertPostingAllowed(auth.uid, work.categoryId, settings.defaultCategoryPostingAllowed);

  const publishCount = await withTransaction(async (c) => {
    const w = await lockWork(c, workId);
    if (!w || w.status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    if (w.status === "flagged") throw conflict("WORK_FLAGGED", "This work was flagged by a moderator.");
    if (w.status === "published") return null;
    // A prompt entry can only be published while the prompt is still open.
    if (w.promptId) {
      await assertCanEnterPrompt(c, { promptId: w.promptId, userId: w.authorId, categoryId: w.categoryId, excludeWorkId: w.id, checkLimit: false });
    }
    const count = w.publishCount + 1;
    await c.query(
      `UPDATE works SET status = 'published', publish_count = $2,
              published_at = COALESCE(published_at, inkspire_now()), updated_at = inkspire_now()
        WHERE id = $1`,
      [workId, count],
    );
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
  await pool.query(
    `UPDATE works SET status = 'archived', updated_at = inkspire_now() WHERE id = $1 AND status = 'published'`,
    [workId],
  );
  return getWorkDto(workId, auth);
}

export async function setVisibility(auth: AuthContext, workId: string, visibility: "public" | "private") {
  await loadOwnWork(workId, auth);
  await pool.query(`UPDATE works SET visibility = $2, updated_at = inkspire_now() WHERE id = $1`, [workId, visibility]);
  return getWorkDto(workId, auth);
}

export async function setCoverImage(workId: string, url: string) {
  await pool.query(`UPDATE works SET cover_image_url = $2, updated_at = inkspire_now() WHERE id = $1`, [workId, url]);
}

/**
 * Takes a work out of its prompt. Allowed for drafts and entries, but never for a winner: the
 * database refuses it too (prompt_winners holds a foreign key to the work and its prompt).
 */
export async function detachFromPrompt(auth: AuthContext, workId: string) {
  await loadOwnWork(workId, auth);
  await withTransaction(async (c) => {
    const w = await lockWork(c, workId);
    if (!w || w.status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    if (!w.promptId) return;
    const won = await c.query(`SELECT 1 FROM prompt_winners WHERE work_id = $1`, [workId]);
    if (won.rowCount) throw conflict("PROMPT_WINNER_LOCKED", "A winning work cannot be removed from its prompt.");
    await c.query(`UPDATE works SET prompt_id = NULL, updated_at = inkspire_now() WHERE id = $1`, [workId]);
  });
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

  await withTransaction(async (c) => {
    const w = await lockWork(c, workId);
    if (!w || w.status === "deleted") return;
    const t = softDeleteTransition({ status: w.status, moderationStatus: w.moderationStatus });
    if (t.noop) return;
    await c.query(
      `UPDATE works SET status = $2, moderation_status = $3, status_before_delete = $4,
              deleted_at = inkspire_now(), deleted_by = $5, updated_at = inkspire_now()
        WHERE id = $1`,
      [workId, t.status, t.moderationStatus, w.status, auth.uid],
    );
    if (t.cancelReview) {
      // A deleted work cannot be reviewed, so the open request is closed.
      const reviewId = w.moderation?.reviewId as string | undefined;
      if (reviewId) {
        await c.query(
          `UPDATE work_review_requests SET status = 'cancelled', resolved_at = inkspire_now() WHERE id = $1`,
          [reviewId],
        );
      }
    }
  });

  const reason = isAuthor ? "Deleted by author" : "Deleted by moderator";
  await logModeration(
    { workId, userId: existing.authorId, moderatorId: auth.uid, actorRole: auth.profile.role, action: "DELETE", reason },
    log,
  );
  if (!isAuthor) {
    await logAdmin({ adminId: auth.uid, action: "WORK_DELETED", targetType: "work", targetId: workId, metadata: { authorId: existing.authorId } }, log);
  }
}
