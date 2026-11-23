import type { PoolClient } from "pg";
import { pool, type Queryable } from "../config/postgres.js";
import { splitIntoChunks, assertChunksWithinLimit, utf8Bytes } from "./chunking.js";
import { badRequest } from "../utils/errors.js";

export interface PreparedContent {
  chunks: string[];
  totalBytes: number;
}

/**
 * Validates size and splits the text into chunks. PostgreSQL has no 1 MiB document limit, but the
 * text is still stored in chunks so readers can stream a long work a few chunks at a time.
 */
export function prepareContent(
  content: string,
  opts: { thresholdBytes: number; maxWorkSizeBytes: number },
): PreparedContent {
  const totalBytes = utf8Bytes(content);
  if (totalBytes > opts.maxWorkSizeBytes) {
    throw badRequest(
      "WORK_TOO_LARGE",
      `This work is too large. The maximum size is ${opts.maxWorkSizeBytes} bytes.`,
    );
  }
  const chunks = splitIntoChunks(content, opts.thresholdBytes);
  if (chunks.length === 0) throw badRequest("EMPTY_CONTENT", "The work has no content.");
  assertChunksWithinLimit(chunks, opts.thresholdBytes);
  return { chunks, totalBytes };
}

const unnestArgs = (chunks: string[]) => [
  chunks.map((_, i) => i),
  chunks,
  chunks.map((c) => utf8Bytes(c)),
];

/** Inserts every chunk of a revision in one statement. Call inside the transaction that creates the revision. */
export async function insertRevisionChunks(client: PoolClient, workId: string, revisionId: string, chunks: string[]): Promise<void> {
  await client.query(
    `INSERT INTO work_revision_chunks (work_id, revision_id, idx, content, byte_size)
     SELECT $1, $2, t.idx, t.content, t.byte_size FROM unnest($3::int[], $4::text[], $5::int[]) AS t(idx, content, byte_size)`,
    [workId, revisionId, ...unnestArgs(chunks)],
  );
}

/** Replaces the autosaved text of a work. Call inside the transaction that updates work_drafts. */
export async function replaceDraftChunks(client: PoolClient, workId: string, chunks: string[]): Promise<void> {
  await client.query(`DELETE FROM work_draft_chunks WHERE work_id = $1`, [workId]);
  await client.query(
    `INSERT INTO work_draft_chunks (work_id, idx, content, byte_size)
     SELECT $1, t.idx, t.content, t.byte_size FROM unnest($2::int[], $3::text[], $4::int[]) AS t(idx, content, byte_size)`,
    [workId, ...unnestArgs(chunks)],
  );
}

export interface ChunkPage {
  chunks: { index: number; content: string }[];
  /** Pass as `after` to continue. null when the end was reached. */
  nextAfter: number | null;
}

function toPage(rows: { idx: number; content: string }[], limit: number): ChunkPage {
  const kept = rows.slice(0, limit);
  const chunks = kept.map((r) => ({ index: r.idx, content: r.content }));
  return { chunks, nextAfter: rows.length > limit && chunks.length ? chunks[chunks.length - 1]!.index : null };
}

/** Reads revision chunks in index order, `limit` at a time, starting after chunk `after`. */
export async function readRevisionChunks(
  workId: string,
  revisionId: string,
  after: number | undefined,
  limit: number,
  db: Queryable = pool,
): Promise<ChunkPage> {
  const res = await db.query(
    `SELECT idx, content FROM work_revision_chunks
      WHERE work_id = $1 AND revision_id = $2 AND idx > $3 ORDER BY idx LIMIT $4`,
    [workId, revisionId, after ?? -1, limit + 1],
  );
  return toPage(res.rows, limit);
}

export async function readDraftChunks(workId: string, after: number | undefined, limit: number, db: Queryable = pool): Promise<ChunkPage> {
  const res = await db.query(
    `SELECT idx, content FROM work_draft_chunks WHERE work_id = $1 AND idx > $2 ORDER BY idx LIMIT $3`,
    [workId, after ?? -1, limit + 1],
  );
  return toPage(res.rows, limit);
}

/** Every chunk of a revision joined into one string. Used by "restore as new revision". */
export async function readRevisionText(workId: string, revisionId: string, db: Queryable = pool): Promise<string> {
  const res = await db.query(
    `SELECT content FROM work_revision_chunks WHERE work_id = $1 AND revision_id = $2 ORDER BY idx`,
    [workId, revisionId],
  );
  return res.rows.map((r) => r.content as string).join("");
}
