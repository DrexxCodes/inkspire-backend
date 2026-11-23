import { pool, type Queryable } from "../config/postgres.js";
import { serialize } from "../utils/serialize.js";
import type { AuthContext, Doc, ModerationStatus, UserDoc, Visibility, WorkStatus } from "../types/domain.js";
import { getCategoryMap } from "./categories.repo.js";
import { getUsersByIds, toAuthorSummary } from "./users.repo.js";

/**
 * Works live in PostgreSQL (see sql/002_works_and_prompts.sql). Users, categories, settings and
 * notifications stay in Firestore, so a work stores their ids as plain text and this module
 * loads the Firestore side in one batch per page.
 */

export interface WorkRecord {
  id: string;
  authorId: string;
  title: string;
  description: string;
  excerpt: string;
  categoryId: string;
  promptId: string | null;
  /** Only set while the prompt is published, so a draft prompt title never leaks through a tag. */
  promptTitle: string | null;
  /** 1 to 3 when the work won its prompt. */
  promptPlacement: number | null;
  coverImageUrl: string | null;
  status: WorkStatus;
  visibility: Visibility;
  moderationStatus: ModerationStatus;
  moderation: Record<string, unknown> | null;
  statusBeforeFlag: WorkStatus | null;
  statusBeforeDelete: WorkStatus | null;
  chunkCount: number;
  totalBytes: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  viewCount: number;
  currentRevisionId: string;
  lastRevisionNumber: number;
  publishCount: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mapWork(r: Row): WorkRecord {
  return {
    id: r.id,
    authorId: r.author_id,
    title: r.title,
    description: r.description ?? "",
    excerpt: r.excerpt ?? "",
    categoryId: r.category_id,
    promptId: r.prompt_id ?? null,
    promptTitle: r.prompt_title ?? null,
    promptPlacement: r.prompt_placement ?? null,
    coverImageUrl: r.cover_image_url ?? null,
    status: r.status,
    visibility: r.visibility,
    moderationStatus: r.moderation_status,
    moderation: r.moderation ?? null,
    statusBeforeFlag: r.status_before_flag ?? null,
    statusBeforeDelete: r.status_before_delete ?? null,
    chunkCount: r.chunk_count,
    totalBytes: r.total_bytes,
    likeCount: r.like_count,
    commentCount: r.comment_count,
    shareCount: r.share_count,
    viewCount: r.view_count,
    currentRevisionId: r.current_revision_id,
    lastRevisionNumber: r.last_revision_number,
    publishCount: r.publish_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at ?? null,
    deletedAt: r.deleted_at ?? null,
    deletedBy: r.deleted_by ?? null,
  };
}

/** The prompt tag and the winner placement ride along with every work that is read for display. */
export const WORK_SELECT = `
  SELECT w.*, p.title AS prompt_title, pw.placement AS prompt_placement
    FROM works w
    LEFT JOIN prompts p ON p.id = w.prompt_id AND p.status = 'published'
    LEFT JOIN prompt_winners pw ON pw.prompt_id = w.prompt_id AND pw.work_id = w.id`;

export async function getWork(id: string, db: Queryable = pool): Promise<WorkRecord | null> {
  const res = await db.query(`${WORK_SELECT} WHERE w.id = $1`, [id]);
  return res.rows[0] ? mapWork(res.rows[0]) : null;
}

/** Row lock for read-then-write sections inside a transaction. The replacement for a Firestore transaction read. */
export async function lockWork(db: Queryable, id: string): Promise<WorkRecord | null> {
  const res = await db.query(`SELECT * FROM works WHERE id = $1 FOR UPDATE`, [id]);
  return res.rows[0] ? mapWork(res.rows[0]) : null;
}

export async function listWorkRows(sql: string, params: unknown[], db: Queryable = pool): Promise<WorkRecord[]> {
  const res = await db.query(sql, params);
  return res.rows.map(mapWork);
}

export const isModerator = (auth?: AuthContext | null) => !!auth?.permissions.moderateWorks;

/**
 * Single source of truth for who may see a work.
 *  - deleted: moderators with delete or moderate rights only
 *  - author: everything except deleted
 *  - moderators: everything
 *  - everyone else: published + public only
 */
export function canViewWork(work: Pick<WorkRecord, "status" | "visibility" | "authorId">, auth?: AuthContext | null): boolean {
  if (work.status === "deleted") return !!auth && (auth.permissions.deleteWorks || auth.permissions.moderateWorks);
  if (auth && work.authorId === auth.uid) return true;
  if (isModerator(auth)) return true;
  return work.status === "published" && work.visibility === "public";
}

export async function hasLiked(workId: string, uid: string, db: Queryable = pool): Promise<boolean> {
  const res = await db.query(`SELECT 1 FROM work_likes WHERE work_id = $1 AND user_id = $2`, [workId, uid]);
  return res.rowCount === 1;
}

export interface Hydration {
  authors: Map<string, UserDoc>;
  categories: Map<string, Doc>;
}

/** Batch loads authors and categories (both Firestore) for a page of works. One round trip each, no N+1. */
export async function hydrateFor(works: Pick<WorkRecord, "authorId" | "categoryId">[]): Promise<Hydration> {
  const [authors, categories] = await Promise.all([
    getUsersByIds(works.map((w) => w.authorId)),
    getCategoryMap(works.map((w) => w.categoryId)),
  ]);
  return { authors, categories };
}

export function toWorkDto(work: WorkRecord, h: Hydration, viewer?: AuthContext | null) {
  const cat = h.categories.get(work.categoryId);
  const privileged = !!viewer && (viewer.uid === work.authorId || isModerator(viewer));
  return serialize({
    id: work.id,
    title: work.title,
    description: work.description,
    excerpt: work.excerpt,
    category: cat
      ? { id: cat.id, name: cat.name as string, slug: cat.slug as string }
      : { id: work.categoryId, name: "Uncategorised", slug: "uncategorised" },
    author: toAuthorSummary(h.authors.get(work.authorId)),
    prompt: work.promptId && work.promptTitle ? { id: work.promptId, title: work.promptTitle, placement: work.promptPlacement } : null,
    coverImageUrl: work.coverImageUrl,
    status: work.status,
    visibility: work.visibility,
    likeCount: Math.max(0, work.likeCount),
    commentCount: Math.max(0, work.commentCount),
    shareCount: Math.max(0, work.shareCount),
    viewCount: Math.max(0, work.viewCount),
    chunkCount: work.chunkCount,
    totalBytes: work.totalBytes,
    currentRevisionId: privileged ? work.currentRevisionId : undefined,
    moderationStatus: privileged ? work.moderationStatus : undefined,
    moderation: privileged ? work.moderation : undefined,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    publishedAt: work.publishedAt,
    viewer: viewer ? { isAuthor: viewer.uid === work.authorId } : { isAuthor: false },
  });
}

export async function hydrateWorks(works: WorkRecord[], viewer?: AuthContext | null) {
  const h = await hydrateFor(works);
  return works.map((w) => toWorkDto(w, h, viewer));
}

/* --------------------------------- Revisions --------------------------------- */

export interface RevisionRecord {
  workId: string;
  id: string;
  revisionNumber: number;
  title: string;
  description: string;
  excerpt: string;
  categoryId: string;
  coverImageUrl: string | null;
  chunkCount: number;
  totalBytes: number;
  createdAt: Date;
  createdBy: string;
  changeReason: string | null;
  basedOnRevisionId: string | null;
  restoredFromRevisionId: string | null;
}

export function mapRevision(r: Row): RevisionRecord {
  return {
    workId: r.work_id,
    id: r.id,
    revisionNumber: r.revision_number,
    title: r.title,
    description: r.description ?? "",
    excerpt: r.excerpt ?? "",
    categoryId: r.category_id,
    coverImageUrl: r.cover_image_url ?? null,
    chunkCount: r.chunk_count,
    totalBytes: r.total_bytes,
    createdAt: r.created_at,
    createdBy: r.created_by,
    changeReason: r.change_reason ?? null,
    basedOnRevisionId: r.based_on_revision_id ?? null,
    restoredFromRevisionId: r.restored_from_revision_id ?? null,
  };
}

export async function getRevision(workId: string, revisionId: string, db: Queryable = pool): Promise<RevisionRecord | null> {
  const res = await db.query(`SELECT * FROM work_revisions WHERE work_id = $1 AND id = $2`, [workId, revisionId]);
  return res.rows[0] ? mapRevision(res.rows[0]) : null;
}

export const toRevisionDto = (r: RevisionRecord, currentRevisionId?: string) =>
  serialize({
    id: r.id,
    revisionNumber: r.revisionNumber,
    title: r.title,
    description: r.description,
    excerpt: r.excerpt,
    categoryId: r.categoryId,
    coverImageUrl: r.coverImageUrl,
    chunkCount: r.chunkCount,
    totalBytes: r.totalBytes,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    changeReason: r.changeReason,
    basedOnRevisionId: r.basedOnRevisionId,
    restoredFromRevisionId: r.restoredFromRevisionId,
    isCurrent: r.id === currentRevisionId,
  });
