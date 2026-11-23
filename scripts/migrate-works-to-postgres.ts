/**
 * One-off: copies every existing work from Firestore into PostgreSQL.
 *
 *   pnpm migrate:works -- --dry-run     reads Firestore, reports what it would copy, writes nothing
 *   pnpm migrate:works                  copies (skips works that are already in PostgreSQL)
 *   pnpm migrate:works -- --replace     deletes and re-copies works that are already there
 *   pnpm migrate:works:prod             same, using .env.prod
 *
 * Run `pnpm db:migrate` first so the tables exist. Firestore is only read. Nothing there is
 * deleted, so you can compare, and remove the old `works` collection yourself once you are happy.
 *
 * What is copied, per work: the work, every revision with its text, the autosave draft with its
 * text, likes, comments and replies, and review requests. Like and comment counters are recomputed
 * from what was copied, so they match the rows exactly. Views and shares are kept as they were.
 * Each work is one PostgreSQL transaction, so a work is either fully copied or not at all.
 * The script can be stopped and run again at any time.
 */
import type { PoolClient } from "pg";
import { db } from "../src/config/firebase.js";
import { pool, withTransaction } from "../src/config/postgres.js";

const DRY = process.argv.includes("--dry-run");
const REPLACE = process.argv.includes("--replace");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;

const isTs = (v: unknown): v is { toDate: () => Date } => !!v && typeof (v as { toDate?: unknown }).toDate === "function";
const date = (v: unknown): Date | null => (isTs(v) ? new Date(v.toDate().getTime()) : v instanceof Date ? v : null); // ms precision
/** Firestore Timestamps inside a map (moderation.flaggedAt, ...) become ISO strings. */
const plain = (v: unknown): unknown =>
  isTs(v) ? v.toDate().toISOString() : Array.isArray(v) ? v.map(plain) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : d);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const stats = { works: 0, skipped: 0, failed: 0, revisions: 0, chunks: 0, likes: 0, comments: 0, reviews: 0, drafts: 0 };
const problems: string[] = [];

async function readChunks(col: FirebaseFirestore.CollectionReference, version?: number) {
  const snap = await col.get();
  return snap.docs
    .map((d) => d.data() as Data)
    .filter((d) => version === undefined || d.version === version)
    .sort((a, b) => num(a.index) - num(b.index))
    .map((d) => str(d.content));
}

async function insertChunks(c: PoolClient, table: string, keyCols: string[], keyVals: string[], chunks: string[]) {
  if (chunks.length === 0) return;
  await c.query(
    `INSERT INTO ${table} (${keyCols.join(", ")}, idx, content, byte_size)
     SELECT ${keyVals.map((_, i) => `$${i + 1}`).join(", ")}, t.idx, t.content, t.byte_size
       FROM unnest($${keyVals.length + 1}::int[], $${keyVals.length + 2}::text[], $${keyVals.length + 3}::int[]) AS t(idx, content, byte_size)`,
    [...keyVals, chunks.map((_, i) => i), chunks, chunks.map(bytes)],
  );
}

async function migrateWork(snap: FirebaseFirestore.QueryDocumentSnapshot) {
  const id = snap.id;
  const w = snap.data() as Data;
  const ref = snap.ref;

  const currentRevisionId = str(w.currentRevisionId, "r1");
  const revSnap = await ref.collection("revisions").get();
  if (revSnap.empty) throw new Error("no revisions");
  const revisions: { id: string; d: Data; chunks: string[] }[] = [];
  for (const r of revSnap.docs) {
    const chunks = await readChunks(r.ref.collection("chunks"));
    const d = r.data() as Data;
    if (chunks.length !== num(d.chunkCount)) throw new Error(`revision ${r.id}: ${chunks.length} chunks found, ${num(d.chunkCount)} expected`);
    revisions.push({ id: r.id, d, chunks });
  }
  if (!revisions.some((r) => r.id === currentRevisionId)) throw new Error(`current revision ${currentRevisionId} is missing`);
  revisions.sort((a, b) => num(a.d.revisionNumber) - num(b.d.revisionNumber));

  const draftSnap = await ref.collection("draftState").doc("current").get();
  const draft = draftSnap.exists ? (draftSnap.data() as Data) : null;
  const draftChunks = draft ? await readChunks(draftSnap.ref.collection("chunks"), draft.version) : [];

  const likes = (await ref.collection("likes").get()).docs.map((d) => ({ uid: d.id, at: date(d.get("createdAt")) }));
  const comments = (await ref.collection("comments").get()).docs.map((d) => ({ id: d.id, d: d.data() as Data }));
  const reviews = (await db.collection("reviewRequests").where("workId", "==", id).get()).docs.map((d) => ({ id: d.id, d: d.data() as Data }));

  const active = comments.filter((c) => c.d.status === "active");
  const replyCounts = new Map<string, number>();
  for (const c of active) if (c.d.parentCommentId) replyCounts.set(c.d.parentCommentId, (replyCounts.get(c.d.parentCommentId) ?? 0) + 1);

  if (DRY) {
    stats.works++;
    stats.revisions += revisions.length;
    stats.chunks += revisions.reduce((n, r) => n + r.chunks.length, 0);
    stats.likes += likes.length;
    stats.comments += comments.length;
    stats.reviews += reviews.length;
    if (draft) stats.drafts++;
    return;
  }

  const outcome = await withTransaction(async (c) => {
    const exists = await c.query(`SELECT 1 FROM works WHERE id = $1`, [id]);
    if (exists.rowCount) {
      if (!REPLACE) return "skipped" as const;
      await c.query(`DELETE FROM works WHERE id = $1`, [id]);
    }
    await c.query(
      `INSERT INTO works (id, author_id, title, description, excerpt, category_id, cover_image_url, status, visibility,
                          moderation_status, moderation, status_before_flag, status_before_delete, chunk_count, total_bytes,
                          like_count, comment_count, share_count, view_count, current_revision_id, last_revision_number,
                          publish_count, created_at, updated_at, published_at, deleted_at, deleted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
               COALESCE($23, inkspire_now()), COALESCE($24, inkspire_now()), $25, $26, $27)`,
      [
        id, str(w.authorId), str(w.title), str(w.description), str(w.excerpt), str(w.categoryId), w.coverImageUrl ?? null,
        str(w.status, "draft"), str(w.visibility, "public"), str(w.moderationStatus, "clean"),
        w.moderation ? JSON.stringify(plain(w.moderation)) : null, w.statusBeforeFlag ?? null, w.statusBeforeDelete ?? null,
        num(w.chunkCount), num(w.totalBytes), likes.length, active.length, num(w.shareCount), num(w.viewCount),
        currentRevisionId, Math.max(num(w.lastRevisionNumber), ...revisions.map((r) => num(r.d.revisionNumber))), num(w.publishCount),
        date(w.createdAt), date(w.updatedAt), date(w.publishedAt), date(w.deletedAt), w.deletedBy ?? null,
      ],
    );
    for (const r of revisions) {
      await c.query(
        `INSERT INTO work_revisions (work_id, id, revision_number, title, description, excerpt, category_id, cover_image_url,
                                     chunk_count, total_bytes, created_at, created_by, change_reason, based_on_revision_id, restored_from_revision_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, inkspire_now()),$12,$13,$14,$15)`,
        [id, r.id, num(r.d.revisionNumber), str(r.d.title), str(r.d.description), str(r.d.excerpt), str(r.d.categoryId),
          r.d.coverImageUrl ?? null, r.chunks.length, num(r.d.totalBytes), date(r.d.createdAt), str(r.d.createdBy, str(w.authorId)),
          r.d.changeReason ?? null, r.d.basedOnRevisionId ?? null, r.d.restoredFromRevisionId ?? null],
      );
      await insertChunks(c, "work_revision_chunks", ["work_id", "revision_id"], [id, r.id], r.chunks);
    }
    if (draft) {
      await c.query(
        `INSERT INTO work_drafts (work_id, version, title, description, category_id, cover_image_url, chunk_count, total_bytes, based_on_revision_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, inkspire_now()))`,
        [id, num(draft.version), str(draft.title), str(draft.description), str(draft.categoryId), draft.coverImageUrl ?? null,
          draftChunks.length, num(draft.totalBytes), draft.basedOnRevisionId ?? null, date(draft.updatedAt)],
      );
      await insertChunks(c, "work_draft_chunks", ["work_id"], [id], draftChunks);
    }
    for (const l of likes) {
      await c.query(`INSERT INTO work_likes (work_id, user_id, created_at) VALUES ($1,$2,COALESCE($3, inkspire_now())) ON CONFLICT DO NOTHING`, [id, l.uid, l.at]);
    }
    // Parents first, so replies always find their parent.
    for (const cm of [...comments].sort((a, b) => Number(!!a.d.parentCommentId) - Number(!!b.d.parentCommentId))) {
      const parent = cm.d.parentCommentId && comments.some((x) => x.id === cm.d.parentCommentId) ? cm.d.parentCommentId : null;
      await c.query(
        `INSERT INTO work_comments (id, work_id, user_id, content, parent_comment_id, status, like_count, reply_count, deleted_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, inkspire_now()),COALESCE($11, inkspire_now()))`,
        [cm.id, id, str(cm.d.userId), str(cm.d.content), parent, cm.d.status === "deleted" ? "deleted" : "active", num(cm.d.likeCount),
          replyCounts.get(cm.id) ?? 0, cm.d.deletedBy ?? null, date(cm.d.createdAt), date(cm.d.updatedAt)],
      );
    }
    for (const r of reviews) {
      const status = ["pending", "approved", "rejected", "cancelled"].includes(r.d.status) ? r.d.status : "cancelled";
      await c.query(
        `INSERT INTO work_review_requests (id, work_id, revision_id, author_id, requested_by, requested_at, status, reason, resolved_by, resolved_at, turnaround_ms)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, inkspire_now()),$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [r.id, id, str(r.d.revisionId), str(r.d.authorId, str(w.authorId)), str(r.d.requestedBy, str(w.authorId)), date(r.d.requestedAt),
          status, r.d.reason ?? null, r.d.resolvedBy ?? null, date(r.d.resolvedAt), r.d.turnaroundMs ?? null],
      );
    }
    return "copied" as const;
  });

  if (outcome === "skipped") {
    stats.skipped++;
    return;
  }
  stats.works++;
  stats.revisions += revisions.length;
  stats.chunks += revisions.reduce((n, r) => n + r.chunks.length, 0);
  stats.likes += likes.length;
  stats.comments += comments.length;
  stats.reviews += reviews.length;
  if (draft) stats.drafts++;
}

async function main() {
  console.log(DRY ? "DRY RUN: nothing will be written." : REPLACE ? "Copying works (replacing ones already in PostgreSQL)." : "Copying works.");
  const PAGE = 100;
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection("works").orderBy("__name__").limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    for (const doc of page.docs) {
      try {
        await migrateWork(doc);
      } catch (err) {
        stats.failed++;
        problems.push(`${doc.id}: ${(err as Error).message}`);
      }
      last = doc;
    }
    process.stdout.write(`\r${stats.works + stats.skipped + stats.failed} works processed`);
  }
  console.log("\n");
  console.table(stats);
  if (problems.length) {
    console.error(`\n${problems.length} work(s) were NOT copied. Fix and run again (finished works are skipped):`);
    for (const p of problems) console.error(`  - ${p}`);
  }
  await pool.end();
  process.exit(problems.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
