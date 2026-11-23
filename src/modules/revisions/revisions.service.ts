import type { PoolClient } from "pg";
import { pool, withTransaction } from "../../config/postgres.js";
import type { AuthContext } from "../../types/domain.js";
import { getRevision as getRevisionRecord, lockWork, mapRevision, toRevisionDto, type WorkRecord } from "../../repositories/works.repo.js";
import { notFound } from "../../utils/errors.js";
import { makeExcerpt } from "../../utils/text.js";
import { serialize } from "../../utils/serialize.js";
import { decodeKey, keysetClause, sliceKeyset } from "../../utils/pagination.js";
import {
  insertRevisionChunks,
  prepareContent,
  readDraftChunks,
  readRevisionChunks,
  readRevisionText,
  replaceDraftChunks,
} from "../../services/content.service.js";
import type { PlatformSettings } from "../../services/settings.service.js";
import { assertPostingAllowed } from "../works/works.guards.js";
import { assertCategoryMatchesPrompt } from "../prompts/prompts.guards.js";

type Logger = { error: (o: object, m: string) => void };

export interface RevisionInput {
  title: string;
  description: string;
  categoryId: string;
  coverImageUrl: string | null;
  content: string;
}

export interface RevisionMeta {
  title: string;
  description: string;
  excerpt: string;
  categoryId: string;
  coverImageUrl: string | null;
  chunkCount: number;
  totalBytes: number;
}

/** Removes any autosaved draft once an explicit revision supersedes it. Chunks go with it (cascade). */
async function clearDraftState(db: Pick<PoolClient, "query">, workId: string): Promise<void> {
  await db.query(`DELETE FROM work_drafts WHERE work_id = $1`, [workId]);
}

/**
 * Makes `revisionId` the work's current content. The text already lives in that revision's chunks,
 * so this is one UPDATE that flips the pointer and copies the revision's metadata onto the work.
 * A reader sees either the old complete version or the new complete one.
 */
async function activate(db: Pick<PoolClient, "query">, workId: string, revisionId: string, meta: RevisionMeta): Promise<void> {
  await db.query(
    `UPDATE works SET title = $2, description = $3, excerpt = $4, category_id = $5, cover_image_url = $6,
            chunk_count = $7, total_bytes = $8, current_revision_id = $9, updated_at = inkspire_now()
      WHERE id = $1`,
    [workId, meta.title, meta.description, meta.excerpt, meta.categoryId, meta.coverImageUrl, meta.chunkCount, meta.totalBytes, revisionId],
  );
}

/** Used by moderation approval, which publishes a reviewed revision inside its own transaction. */
export async function activateRevisionIn(db: Pick<PoolClient, "query">, workId: string, revisionId: string): Promise<void> {
  const rev = await getRevisionRecord(workId, revisionId, db as PoolClient);
  if (!rev) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  await activate(db, workId, revisionId, rev);
}

export interface SaveRevisionArgs {
  work: WorkRecord;
  actor: AuthContext;
  input: RevisionInput;
  settings: PlatformSettings;
  makeCurrent: boolean;
  changeReason?: string;
  basedOnRevisionId?: string | null;
  restoredFromRevisionId?: string | null;
}

/**
 * Creates a new immutable revision. Number allocation, the revision, its chunks, the pointer flip
 * and the autosave cleanup happen in one transaction, so two simultaneous saves can never share a
 * number and a failure leaves nothing behind.
 */
export async function saveRevision(args: SaveRevisionArgs, _log: Logger) {
  const { work, actor, input, settings } = args;
  const workId = work.id;

  await assertPostingAllowed(actor.uid, input.categoryId, settings.defaultCategoryPostingAllowed);
  await assertCategoryMatchesPrompt(pool, work.promptId, input.categoryId);
  const prepared = prepareContent(input.content, {
    thresholdBytes: settings.contentChunkThresholdBytes,
    maxWorkSizeBytes: settings.maxWorkSizeBytes,
  });
  const meta: RevisionMeta = {
    title: input.title,
    description: input.description,
    excerpt: makeExcerpt(input.content),
    categoryId: input.categoryId,
    coverImageUrl: input.coverImageUrl,
    chunkCount: prepared.chunks.length,
    totalBytes: prepared.totalBytes,
  };

  return withTransaction(async (c) => {
    const locked = await lockWork(c, workId);
    if (!locked) throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    if (args.makeCurrent && locked.status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    if (args.basedOnRevisionId && !(await getRevisionRecord(workId, args.basedOnRevisionId, c))) {
      throw notFound("REVISION_NOT_FOUND", "The revision you based this on does not exist.");
    }

    const number = locked.lastRevisionNumber + 1;
    const revisionId = `r${number}`;
    await c.query(`UPDATE works SET last_revision_number = $2 WHERE id = $1`, [workId, number]);
    await c.query(
      `INSERT INTO work_revisions (work_id, id, revision_number, title, description, excerpt, category_id, cover_image_url,
                                   chunk_count, total_bytes, created_by, change_reason, based_on_revision_id, restored_from_revision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [workId, revisionId, number, meta.title, meta.description, meta.excerpt, meta.categoryId, meta.coverImageUrl,
        meta.chunkCount, meta.totalBytes, actor.uid, args.changeReason ?? null, args.basedOnRevisionId ?? null,
        args.restoredFromRevisionId ?? null],
    );
    await insertRevisionChunks(c, workId, revisionId, prepared.chunks);

    if (args.makeCurrent) {
      await activate(c, workId, revisionId, meta);
      await clearDraftState(c, workId);
    }
    return { revisionId, revisionNumber: number, madeCurrent: args.makeCurrent };
  });
}

export async function promoteRevision(
  work: WorkRecord,
  actor: AuthContext,
  revisionId: string,
  settings: PlatformSettings,
  _log: Logger,
) {
  const rev = await getRevisionRecord(work.id, revisionId);
  if (!rev) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  if (work.currentRevisionId === revisionId) return; // already current, nothing to do
  await assertPostingAllowed(actor.uid, rev.categoryId, settings.defaultCategoryPostingAllowed);
  await assertCategoryMatchesPrompt(pool, work.promptId, rev.categoryId);
  await withTransaction(async (c) => {
    const locked = await lockWork(c, work.id);
    if (!locked || locked.status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    await activate(c, work.id, revisionId, rev);
  });
}

/** Restoring never overwrites history: it appends a new revision that copies an old one. */
export async function restoreRevision(
  work: WorkRecord,
  actor: AuthContext,
  revisionId: string,
  settings: PlatformSettings,
  log: Logger,
) {
  const rev = await getRevisionRecord(work.id, revisionId);
  if (!rev) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  const content = await readRevisionText(work.id, revisionId);
  return saveRevision(
    {
      work,
      actor,
      settings,
      makeCurrent: true,
      changeReason: `Restored from version ${rev.revisionNumber}`,
      basedOnRevisionId: revisionId,
      restoredFromRevisionId: revisionId,
      input: {
        title: rev.title,
        description: rev.description,
        categoryId: rev.categoryId,
        coverImageUrl: rev.coverImageUrl,
        content,
      },
    },
    log,
  );
}

export async function listRevisions(work: WorkRecord, opts: { cursor?: string; limit: number }) {
  const values: unknown[] = [work.id];
  const where = [`work_id = $1`];
  const after = keysetClause(["revision_number"], ["int"], "desc", decodeKey(opts.cursor, ["int"]), values);
  if (after) where.push(after);
  values.push(opts.limit + 1);
  const res = await pool.query(
    `SELECT * FROM work_revisions WHERE ${where.join(" AND ")} ORDER BY revision_number DESC LIMIT $${values.length}`,
    values,
  );
  const page = sliceKeyset(res.rows.map(mapRevision), opts.limit, (r) => [r.revisionNumber]);
  return { items: page.rows.map((r) => toRevisionDto(r, work.currentRevisionId)), nextCursor: page.nextCursor };
}

export async function getRevision(work: WorkRecord, revisionId: string) {
  const rev = await getRevisionRecord(work.id, revisionId);
  if (!rev) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  return toRevisionDto(rev, work.currentRevisionId);
}

export async function readRevisionContent(work: WorkRecord, revisionId: string, after: number | undefined, limit: number) {
  if (!(await getRevisionRecord(work.id, revisionId))) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  return readRevisionChunks(work.id, revisionId, after, limit);
}

/* ------------------------------ Autosave draft state ------------------------------ */

/**
 * Autosave writes to a separate "current draft state". It never creates a revision, so typing
 * does not fill the history. The state row and its chunks are replaced in one transaction, so a
 * half written save is never read.
 */
export async function saveDraftState(
  work: WorkRecord,
  input: {
    title: string;
    description: string;
    categoryId: string;
    coverImageUrl?: string | null;
    content: string;
    basedOnRevisionId?: string;
  },
  settings: PlatformSettings,
  _log: Logger,
) {
  const prepared = prepareContent(input.content, {
    thresholdBytes: settings.contentChunkThresholdBytes,
    maxWorkSizeBytes: settings.maxWorkSizeBytes,
  });
  const version = Date.now();
  await withTransaction(async (c) => {
    // Deleted works cannot be autosaved. The lock also keeps a concurrent hard delete from racing the insert.
    const locked = await lockWork(c, work.id);
    if (!locked || locked.status === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    await c.query(
      `INSERT INTO work_drafts (work_id, version, title, description, category_id, cover_image_url, chunk_count, total_bytes, based_on_revision_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, inkspire_now())
       ON CONFLICT (work_id) DO UPDATE SET version = EXCLUDED.version, title = EXCLUDED.title, description = EXCLUDED.description,
         category_id = EXCLUDED.category_id, cover_image_url = EXCLUDED.cover_image_url, chunk_count = EXCLUDED.chunk_count,
         total_bytes = EXCLUDED.total_bytes, based_on_revision_id = EXCLUDED.based_on_revision_id, updated_at = EXCLUDED.updated_at`,
      [work.id, version, input.title, input.description, input.categoryId, input.coverImageUrl ?? null,
        prepared.chunks.length, prepared.totalBytes, input.basedOnRevisionId ?? work.currentRevisionId ?? null],
    );
    await replaceDraftChunks(c, work.id, prepared.chunks);
  });
  return { version, totalBytes: prepared.totalBytes };
}

export async function getDraftState(workId: string) {
  const res = await pool.query(`SELECT * FROM work_drafts WHERE work_id = $1`, [workId]);
  const r = res.rows[0];
  if (!r) return null;
  return serialize({
    version: Number(r.version),
    title: r.title,
    description: r.description,
    categoryId: r.category_id,
    coverImageUrl: r.cover_image_url ?? null,
    chunkCount: r.chunk_count,
    totalBytes: r.total_bytes,
    basedOnRevisionId: r.based_on_revision_id ?? null,
    updatedAt: r.updated_at,
  });
}

export async function readDraftContent(workId: string, after: number | undefined, limit: number) {
  const exists = await pool.query(`SELECT 1 FROM work_drafts WHERE work_id = $1`, [workId]);
  if (!exists.rowCount) throw notFound("DRAFT_NOT_FOUND", "There is no autosaved draft.");
  return readDraftChunks(workId, after, limit);
}
