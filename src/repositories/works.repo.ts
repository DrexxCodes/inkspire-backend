import { db } from "../config/firebase.js";
import { serialize } from "../utils/serialize.js";
import type { AuthContext, Doc, UserDoc } from "../types/domain.js";
import { getCategoryMap } from "./categories.repo.js";
import { getUsersByIds, toAuthorSummary } from "./users.repo.js";

export const worksCol = () => db.collection("works");
export const workRef = (id: string) => worksCol().doc(id);
export const workChunks = (id: string) => workRef(id).collection("chunks");
export const revisionsCol = (id: string) => workRef(id).collection("revisions");
export const revisionRef = (id: string, revId: string) => revisionsCol(id).doc(revId);
export const revisionChunks = (id: string, revId: string) => revisionRef(id, revId).collection("chunks");
export const draftStateRef = (id: string) => workRef(id).collection("draftState").doc("current");
export const draftChunks = (id: string) => draftStateRef(id).collection("chunks");
export const likesCol = (id: string) => workRef(id).collection("likes");
export const commentsCol = (id: string) => workRef(id).collection("comments");
export const reviewsCol = () => db.collection("reviewRequests");

export async function getWork(id: string): Promise<Doc | null> {
  const snap = await workRef(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Doc) : null;
}

export const isModerator = (auth?: AuthContext | null) => !!auth?.permissions.moderateWorks;

/**
 * Single source of truth for who may see a work.
 *  - deleted: moderators with delete or moderate rights only
 *  - author: everything except deleted
 *  - moderators: everything
 *  - everyone else: published + public only
 */
export function canViewWork(work: Doc, auth?: AuthContext | null): boolean {
  if (work.status === "deleted") return !!auth && (auth.permissions.deleteWorks || auth.permissions.moderateWorks);
  if (auth && work.authorId === auth.uid) return true;
  if (isModerator(auth)) return true;
  return work.status === "published" && work.visibility === "public";
}

export interface Hydration {
  authors: Map<string, UserDoc>;
  categories: Map<string, Doc>;
}

/** Batch loads authors and categories for a page of works. One round trip each, no N+1. */
export async function hydrateFor(works: Doc[]): Promise<Hydration> {
  const [authors, categories] = await Promise.all([
    getUsersByIds(works.map((w) => w.authorId as string)),
    getCategoryMap(works.map((w) => w.categoryId as string)),
  ]);
  return { authors, categories };
}

export function toWorkDto(work: Doc, h: Hydration, viewer?: AuthContext | null) {
  const cat = h.categories.get(work.categoryId as string);
  const privileged = !!viewer && (viewer.uid === work.authorId || isModerator(viewer));
  return serialize({
    id: work.id,
    title: work.title,
    description: work.description ?? "",
    excerpt: work.excerpt ?? "",
    category: cat
      ? { id: cat.id, name: cat.name as string, slug: cat.slug as string }
      : { id: work.categoryId as string, name: "Uncategorised", slug: "uncategorised" },
    author: toAuthorSummary(h.authors.get(work.authorId as string)),
    coverImageUrl: work.coverImageUrl ?? null,
    status: work.status,
    visibility: work.visibility,
    likeCount: Math.max(0, work.likeCount ?? 0),
    commentCount: Math.max(0, work.commentCount ?? 0),
    shareCount: Math.max(0, work.shareCount ?? 0),
    viewCount: Math.max(0, work.viewCount ?? 0),
    chunkCount: work.chunkCount ?? 0,
    totalBytes: work.totalBytes ?? 0,
    currentRevisionId: privileged ? work.currentRevisionId : undefined,
    moderationStatus: privileged ? work.moderationStatus : undefined,
    moderation: privileged ? work.moderation ?? null : undefined,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    publishedAt: work.publishedAt ?? null,
    viewer: viewer ? { isAuthor: viewer.uid === work.authorId } : { isAuthor: false },
  });
}

export async function hydrateWorks(works: Doc[], viewer?: AuthContext | null) {
  const h = await hydrateFor(works);
  return works.map((w) => toWorkDto(w, h, viewer));
}
