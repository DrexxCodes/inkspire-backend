import { FieldPath, FieldValue, type CollectionReference } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { splitIntoChunks, assertChunksWithinLimit, utf8Bytes, chunkId } from "./chunking.js";
import { badRequest } from "../utils/errors.js";

/** Keeps each Firestore commit well below the 10 MiB request limit. */
const MAX_BATCH_DOCS = 400;
const MAX_BATCH_BYTES = 6 * 1024 * 1024;

export { chunkId };

export interface PreparedContent {
  chunks: string[];
  totalBytes: number;
}

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

export async function deleteDocs(col: CollectionReference, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MAX_BATCH_DOCS) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + MAX_BATCH_DOCS)) batch.delete(col.doc(id));
    await batch.commit();
  }
}

/**
 * Writes chunk documents using size aware batches. If any commit fails, everything written so
 * far is removed so no orphaned chunks are left behind. Chunks are written BEFORE the document
 * that points at them, which keeps partially written content invisible to readers.
 */
export async function writeChunks(
  col: CollectionReference,
  prefix: string,
  chunks: string[],
  extra: Record<string, unknown> = {},
): Promise<string[]> {
  const written: string[] = [];
  let batch = db.batch();
  let count = 0;
  let bytes = 0;

  const flush = async () => {
    if (count === 0) return;
    await batch.commit();
    batch = db.batch();
    count = 0;
    bytes = 0;
  };

  try {
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i]!;
      const size = utf8Bytes(content);
      if (count >= MAX_BATCH_DOCS || (count > 0 && bytes + size > MAX_BATCH_BYTES)) await flush();
      const id = chunkId(prefix, i);
      batch.set(col.doc(id), {
        index: i,
        content,
        byteSize: size,
        ...extra,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      written.push(id);
      count++;
      bytes += size;
    }
    await flush();
  } catch (err) {
    await deleteDocs(col, written).catch(() => undefined);
    throw err;
  }
  return written;
}

export interface ChunkPage {
  chunks: { index: number; content: string }[];
  /** Pass as `after` to continue. null when the end was reached. */
  nextAfter: number | null;
}

/** Reads chunks in index order using a document id range query (no composite index needed). */
export async function readChunks(
  col: CollectionReference,
  prefix: string,
  after: number | undefined,
  limit: number,
): Promise<ChunkPage> {
  const start = chunkId(prefix, after === undefined ? 0 : after + 1);
  const snap = await col
    .where(FieldPath.documentId(), ">=", start)
    .where(FieldPath.documentId(), "<", `${prefix}￿`)
    .orderBy(FieldPath.documentId())
    .limit(limit + 1)
    .get();
  const docs = snap.docs.slice(0, limit);
  const chunks = docs.map((d) => ({ index: d.get("index") as number, content: d.get("content") as string }));
  const hasMore = snap.docs.length > limit;
  return { chunks, nextAfter: hasMore && chunks.length ? chunks[chunks.length - 1]!.index : null };
}

/** Reads every chunk. Only for server side copy operations. */
export async function readAllChunks(col: CollectionReference, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await readChunks(col, prefix, after, 4);
    out.push(...page.chunks.map((c) => c.content));
    if (page.nextAfter === null) return out;
    after = page.nextAfter;
  }
}

/**
 * Removes chunk documents whose id does not start with `keepPrefix`. Best effort cleanup.
 * Documents younger than `minAgeMs` are left alone: they may belong to a save that is still
 * in flight and has not flipped its pointer yet. They are removed by a later cleanup.
 */
export async function purgeChunksExcept(
  col: CollectionReference,
  keepPrefix: string,
  minAgeMs = 0,
): Promise<void> {
  const snap = await col.select("createdAt").get();
  const cutoff = Date.now() - minAgeMs;
  const stale = snap.docs
    .filter((d) => !d.id.startsWith(keepPrefix))
    .filter((d) => {
      const created = d.get("createdAt") as FirebaseFirestore.Timestamp | undefined;
      return !created || created.toMillis() <= cutoff;
    })
    .map((d) => d.id);
  if (stale.length) await deleteDocs(col, stale);
}
