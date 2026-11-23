import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../config/postgres.js";
import { getAuth, optionalUser, requireUser } from "../../middleware/authenticate.js";
import { requireFeature } from "../../middleware/authorize.js";
import { lockWork } from "../../repositories/works.repo.js";
import { getUsersByIds, toAuthorSummary } from "../../repositories/users.repo.js";
import { settingsService } from "../../services/settings.service.js";
import { newEventId, track } from "../../services/analytics.service.js";
import { notify } from "../../services/notifications.service.js";
import { badRequest, forbidden, notFound } from "../../utils/errors.js";
import { clampLimit, decodeKey, keysetClause, sliceKeyset } from "../../utils/pagination.js";
import { newId } from "../../utils/ids.js";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function toDtos(rows: Row[]) {
  const users = await getUsersByIds(rows.map((r) => r.user_id as string));
  return rows.map((r) => {
    const deleted = r.status === "deleted";
    return serialize({
      id: r.id,
      content: deleted ? "" : r.content,
      status: r.status,
      parentCommentId: r.parent_comment_id ?? null,
      replyCount: Math.max(0, r.reply_count ?? 0),
      likeCount: Math.max(0, r.like_count ?? 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      author: toAuthorSummary(users.get(r.user_id as string)),
      authorId: r.user_id,
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
    const limit = clampLimit(q.limit, replies ? 20 : 10, 30);
    const values: unknown[] = [id];
    const where = [`work_id = $1`];
    if (q.parent) {
      values.push(q.parent);
      where.push(`parent_comment_id = $${values.length}`);
    } else {
      where.push(`parent_comment_id IS NULL`);
    }
    // Moderator removed comments stay as a placeholder only when they have replies.
    where.push(`(status <> 'deleted' OR reply_count > 0)`);
    const dir = replies ? "asc" : "desc";
    const after = keysetClause(["created_at", "id"], ["ts", "text"], dir, decodeKey(q.cursor, ["ts", "text"]), values);
    if (after) where.push(after);
    values.push(limit + 1);
    const res = await pool.query(
      `SELECT * FROM work_comments WHERE ${where.join(" AND ")}
        ORDER BY created_at ${dir}, id ${dir} LIMIT $${values.length}`,
      values,
    );
    const page = sliceKeyset(res.rows, limit, (r) => [r.created_at, r.id]);
    return okPage(await toDtos(page.rows), page.nextCursor);
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

    const commentId = newId();
    const created = await withTransaction(async (c) => {
      // The work row lock serialises counter updates for this work.
      if (!(await lockWork(c, id))) throw notFound("WORK_NOT_FOUND", "That work does not exist or is not available.");
      // Threads are two levels deep: a reply to a reply attaches to the original comment.
      let parentId: string | null = null;
      if (body.parentCommentId) {
        const p = await c.query(
          `SELECT id, parent_comment_id, status FROM work_comments WHERE id = $1 AND work_id = $2 FOR UPDATE`,
          [body.parentCommentId, id],
        );
        const parent = p.rows[0];
        if (!parent || parent.status !== "active") {
          throw notFound("COMMENT_NOT_FOUND", "The comment you are replying to no longer exists.");
        }
        parentId = parent.parent_comment_id ?? parent.id;
        await c.query(`UPDATE work_comments SET reply_count = reply_count + 1 WHERE id = $1`, [parentId]);
      }
      const ins = await c.query(
        `INSERT INTO work_comments (id, work_id, user_id, content, parent_comment_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [commentId, id, auth.uid, body.content, parentId],
      );
      await c.query(`UPDATE works SET comment_count = comment_count + 1 WHERE id = $1`, [id]);
      return ins.rows[0] as Row;
    });

    track({ eventId: newEventId(`comment:${commentId}`), metric: "comments" }, req.log);
    if (work.authorId !== auth.uid) {
      await notify(work.authorId, { type: "NEW_COMMENT", title: "New comment on your work", body: work.title, workId: id }, req.log);
    }
    reply.status(201);
    return ok({ comment: (await toDtos([created]))[0] });
  });

  // Authors can remove their own comments. Moderators can remove any.
  app.delete("/:id/comments/:commentId", { preHandler: requireUser }, async (req) => {
    const auth = getAuth(req);
    const { id, commentId } = parse(commentParams, req.params);
    await withTransaction(async (c) => {
      if (!(await lockWork(c, id))) throw notFound("COMMENT_NOT_FOUND", "That comment does not exist.");
      const res = await c.query(`SELECT * FROM work_comments WHERE id = $1 AND work_id = $2 FOR UPDATE`, [commentId, id]);
      const row = res.rows[0] as Row | undefined;
      if (!row || row.status === "deleted") throw notFound("COMMENT_NOT_FOUND", "That comment does not exist.");
      if (row.user_id !== auth.uid && !auth.permissions.moderateWorks) {
        throw forbidden("INSUFFICIENT_PERMISSIONS", "You can only delete your own comments.");
      }
      await c.query(
        `UPDATE work_comments SET status = 'deleted', content = '', deleted_by = $2, updated_at = inkspire_now() WHERE id = $1`,
        [commentId, auth.uid],
      );
      await c.query(`UPDATE works SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1`, [id]);
      if (row.parent_comment_id) {
        await c.query(`UPDATE work_comments SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = $1`, [row.parent_comment_id]);
      }
    });
    return ok({ deleted: true });
  });
}
