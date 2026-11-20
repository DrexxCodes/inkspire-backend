import { FieldValue } from "firebase-admin/firestore";
import { db } from "../../config/firebase.js";
import type { AuthContext, Doc } from "../../types/domain.js";
import {
  draftChunks,
  draftStateRef,
  revisionChunks,
  revisionRef,
  revisionsCol,
  workChunks,
  workRef,
} from "../../repositories/works.repo.js";
import { notFound } from "../../utils/errors.js";
import { makeExcerpt } from "../../utils/text.js";
import { serialize } from "../../utils/serialize.js";
import { runPage } from "../../utils/pagination.js";
import {
  chunkId,
  deleteDocs,
  prepareContent,
  purgeChunksExcept,
  readAllChunks,
  readChunks,
  writeChunks,
} from "../../services/content.service.js";
import type { PlatformSettings } from "../../services/settings.service.js";
import { assertPostingAllowed } from "../works/works.guards.js";

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

/** Number allocation is transactional so two simultaneous saves can never share a number. */
async function reserveRevisionNumber(workId: string): Promise<number> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    if (!snap.exists) throw notFound("WORK_NOT_FOUND", "That work does not exist.");
    const next = ((snap.get("lastRevisionNumber") as number | undefined) ?? 0) + 1;
    tx.update(workRef(workId), { lastRevisionNumber: next });
    return next;
  });
}

/** Removes any autosaved draft state once an explicit revision supersedes it. */
export async function clearDraftState(workId: string): Promise<void> {
  await db.recursiveDelete(draftStateRef(workId)).catch(() => undefined);
}

/**
 * Makes `revisionId` the work's current content.
 *
 * Order matters: the work's chunks are written first (invisible, because readers resolve chunks
 * through `currentRevisionId`), then ONE transaction flips the pointer. A failure at any point
 * leaves readers on the previous, complete version. Stale chunks are cleaned up afterwards.
 */
export async function activateRevision(
  workId: string,
  revisionId: string,
  meta: RevisionMeta,
  log: Logger,
  chunks?: string[],
): Promise<void> {
  const prefix = `${revisionId}_`;
  const col = workChunks(workId);

  const already = await col.doc(chunkId(prefix, 0)).get();
  if (!already.exists) {
    const content = chunks ?? (await readAllChunks(revisionChunks(workId, revisionId), ""));
    await writeChunks(col, prefix, content, { revisionId });
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(workRef(workId));
    if (!snap.exists || snap.get("status") === "deleted") throw notFound("WORK_NOT_FOUND", "That work does not exist.");

    tx.update(workRef(workId), {
      title: meta.title,
      titleLower: meta.title.toLowerCase(),
      description: meta.description,
      excerpt: meta.excerpt,
      categoryId: meta.categoryId,
      coverImageUrl: meta.coverImageUrl,
      chunkCount: meta.chunkCount,
      totalBytes: meta.totalBytes,
      currentRevisionId: revisionId,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // A published work that changes category moves its public counter with it.
    const oldCategory = snap.get("categoryId") as string;
    if (snap.get("status") === "published" && oldCategory !== meta.categoryId) {
      tx.set(db.collection("categories").doc(oldCategory), { publishedCount: FieldValue.increment(-1) }, { merge: true });
      tx.set(db.collection("categories").doc(meta.categoryId), { publishedCount: FieldValue.increment(1) }, { merge: true });
    }
  });

  // Best effort. Young chunks are skipped so a concurrent save cannot lose its own content.
  await purgeChunksExcept(col, prefix, 120_000).catch((err: Error) =>
    log.error({ workId, err: err.message }, "STALE_CHUNK_CLEANUP_FAILED"),
  );
}

export interface SaveRevisionArgs {
  work: Doc;
  actor: AuthContext;
  input: RevisionInput;
  settings: PlatformSettings;
  makeCurrent: boolean;
  changeReason?: string;
  basedOnRevisionId?: string | null;
  restoredFromRevisionId?: string | null;
}

/** Creates a new immutable revision. Existing revisions are never modified. */
export async function saveRevision(args: SaveRevisionArgs, log: Logger) {
  const { work, actor, input, settings } = args;
  const workId = work.id;

  await assertPostingAllowed(actor.uid, input.categoryId, settings.defaultCategoryPostingAllowed);
  const prepared = prepareContent(input.content, {
    thresholdBytes: settings.contentChunkThresholdBytes,
    maxWorkSizeBytes: settings.maxWorkSizeBytes,
  });

  if (args.basedOnRevisionId) {
    const base = await revisionRef(workId, args.basedOnRevisionId).get();
    if (!base.exists) throw notFound("REVISION_NOT_FOUND", "The revision you based this on does not exist.");
  }

  const number = await reserveRevisionNumber(workId);
  const revisionId = `r${number}`;
  const meta: RevisionMeta = {
    title: input.title,
    description: input.description,
    excerpt: makeExcerpt(input.content),
    categoryId: input.categoryId,
    coverImageUrl: input.coverImageUrl,
    chunkCount: prepared.chunks.length,
    totalBytes: prepared.totalBytes,
  };

  const writtenIds = await writeChunks(revisionChunks(workId, revisionId), "", prepared.chunks);
  try {
    // create() fails if the id exists, which is what makes revisions immutable.
    await revisionRef(workId, revisionId).create({
      revisionNumber: number,
      ...meta,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: actor.uid,
      changeReason: args.changeReason ?? null,
      basedOnRevisionId: args.basedOnRevisionId ?? null,
      restoredFromRevisionId: args.restoredFromRevisionId ?? null,
    });
  } catch (err) {
    await deleteDocs(revisionChunks(workId, revisionId), writtenIds).catch(() => undefined);
    throw err;
  }

  if (args.makeCurrent) {
    await activateRevision(workId, revisionId, meta, log, prepared.chunks);
    await clearDraftState(workId);
  }

  return { revisionId, revisionNumber: number, madeCurrent: args.makeCurrent };
}

export async function promoteRevision(
  work: Doc,
  actor: AuthContext,
  revisionId: string,
  settings: PlatformSettings,
  log: Logger,
) {
  const snap = await revisionRef(work.id, revisionId).get();
  if (!snap.exists) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  if (work.currentRevisionId === revisionId) return; // already current, nothing to do
  const data = snap.data()!;
  await assertPostingAllowed(actor.uid, data.categoryId as string, settings.defaultCategoryPostingAllowed);
  await activateRevision(
    work.id,
    revisionId,
    {
      title: data.title,
      description: data.description ?? "",
      excerpt: data.excerpt ?? "",
      categoryId: data.categoryId,
      coverImageUrl: data.coverImageUrl ?? null,
      chunkCount: data.chunkCount,
      totalBytes: data.totalBytes,
    },
    log,
  );
}

/** Restoring never overwrites history: it appends a new revision that copies an old one. */
export async function restoreRevision(
  work: Doc,
  actor: AuthContext,
  revisionId: string,
  settings: PlatformSettings,
  log: Logger,
) {
  const snap = await revisionRef(work.id, revisionId).get();
  if (!snap.exists) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  const data = snap.data()!;
  const content = (await readAllChunks(revisionChunks(work.id, revisionId), "")).join("");
  return saveRevision(
    {
      work,
      actor,
      settings,
      makeCurrent: true,
      changeReason: `Restored from version ${data.revisionNumber}`,
      basedOnRevisionId: revisionId,
      restoredFromRevisionId: revisionId,
      input: {
        title: data.title,
        description: data.description ?? "",
        categoryId: data.categoryId,
        coverImageUrl: data.coverImageUrl ?? null,
        content,
      },
    },
    log,
  );
}

export const toRevisionDto = (id: string, data: FirebaseFirestore.DocumentData, currentRevisionId?: string) =>
  serialize({
    id,
    revisionNumber: data.revisionNumber,
    title: data.title,
    description: data.description ?? "",
    excerpt: data.excerpt ?? "",
    categoryId: data.categoryId,
    coverImageUrl: data.coverImageUrl ?? null,
    chunkCount: data.chunkCount,
    totalBytes: data.totalBytes,
    createdAt: data.createdAt,
    createdBy: data.createdBy,
    changeReason: data.changeReason ?? null,
    basedOnRevisionId: data.basedOnRevisionId ?? null,
    restoredFromRevisionId: data.restoredFromRevisionId ?? null,
    isCurrent: id === currentRevisionId,
  });

export async function listRevisions(work: Doc, opts: { cursor?: string; limit: number }) {
  const { docs, nextCursor } = await runPage(revisionsCol(work.id).orderBy("revisionNumber", "desc"), {
    limit: opts.limit,
    cursor: opts.cursor,
    cursorFields: (d) => [d.get("revisionNumber")],
  });
  return {
    items: docs.map((d) => toRevisionDto(d.id, d.data(), work.currentRevisionId as string | undefined)),
    nextCursor,
  };
}

export async function getRevision(work: Doc, revisionId: string) {
  const snap = await revisionRef(work.id, revisionId).get();
  if (!snap.exists) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  return toRevisionDto(snap.id, snap.data()!, work.currentRevisionId as string | undefined);
}

export async function readRevisionContent(work: Doc, revisionId: string, after: number | undefined, limit: number) {
  const exists = await revisionRef(work.id, revisionId).get();
  if (!exists.exists) throw notFound("REVISION_NOT_FOUND", "That revision does not exist.");
  return readChunks(revisionChunks(work.id, revisionId), "", after, limit);
}

/* ------------------------------ Autosave draft state ------------------------------ */

/**
 * Autosave writes to a separate "current draft state". It never creates a revision, so typing
 * does not fill the history. Chunks are versioned so a half written save is never read.
 */
export async function saveDraftState(
  work: Doc,
  input: {
    title: string;
    description: string;
    categoryId: string;
    coverImageUrl?: string | null;
    content: string;
    basedOnRevisionId?: string;
  },
  settings: PlatformSettings,
  log: Logger,
) {
  const prepared = prepareContent(input.content, {
    thresholdBytes: settings.contentChunkThresholdBytes,
    maxWorkSizeBytes: settings.maxWorkSizeBytes,
  });
  const version = Date.now();
  const prefix = `${version}_`;
  await writeChunks(draftChunks(work.id), prefix, prepared.chunks, { version });
  await draftStateRef(work.id).set({
    version,
    title: input.title,
    description: input.description,
    categoryId: input.categoryId,
    coverImageUrl: input.coverImageUrl ?? null,
    chunkCount: prepared.chunks.length,
    totalBytes: prepared.totalBytes,
    basedOnRevisionId: input.basedOnRevisionId ?? (work.currentRevisionId as string | undefined) ?? null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await purgeChunksExcept(draftChunks(work.id), prefix, 30_000).catch((err: Error) =>
    log.error({ workId: work.id, err: err.message }, "DRAFT_CHUNK_CLEANUP_FAILED"),
  );
  return { version, totalBytes: prepared.totalBytes };
}

export async function getDraftState(workId: string) {
  const snap = await draftStateRef(workId).get();
  return snap.exists ? serialize({ ...snap.data() }) : null;
}

export async function readDraftContent(workId: string, after: number | undefined, limit: number) {
  const snap = await draftStateRef(workId).get();
  if (!snap.exists) throw notFound("DRAFT_NOT_FOUND", "There is no autosaved draft.");
  return readChunks(draftChunks(workId), `${snap.get("version")}_`, after, limit);
}
