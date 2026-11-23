import { query } from "../config/postgres.js";

/**
 * Work derived numbers. They used to be counters kept on Firestore user, category and platform
 * documents. Now that works live in PostgreSQL they are computed here from the works table, so
 * they can never drift from the real data and no cross database write is needed.
 */

export interface AuthorStats {
  publishedWorks: number;
  likesReceived: number;
}

export const NO_STATS: AuthorStats = { publishedWorks: 0, likesReceived: 0 };

/** Published work count and likes received for a set of authors, in one query. */
export async function getAuthorStats(ids: string[]): Promise<Map<string, AuthorStats>> {
  const out = new Map<string, AuthorStats>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const res = await query<{ author_id: string; published: number; likes: number }>(
    `SELECT author_id,
            count(*) FILTER (WHERE status = 'published')::int AS published,
            COALESCE(sum(like_count) FILTER (WHERE status <> 'deleted'), 0)::int AS likes
       FROM works WHERE author_id = ANY($1::text[]) GROUP BY author_id`,
    [unique],
  );
  for (const r of res.rows) out.set(r.author_id, { publishedWorks: r.published, likesReceived: r.likes });
  return out;
}

export async function getOneAuthorStats(id: string): Promise<AuthorStats> {
  return (await getAuthorStats([id])).get(id) ?? NO_STATS;
}

export const statsOrEmpty = (m: Map<string, AuthorStats>, id: string): AuthorStats => m.get(id) ?? NO_STATS;

/** categoryId -> number of published works. */
export async function publishedCountsByCategory(): Promise<Map<string, number>> {
  const res = await query<{ category_id: string; n: number }>(
    `SELECT category_id, count(*)::int AS n FROM works WHERE status = 'published' GROUP BY category_id`,
  );
  return new Map(res.rows.map((r) => [r.category_id, r.n]));
}

export async function categoryHasWorks(categoryId: string): Promise<boolean> {
  const res = await query(`SELECT 1 FROM works WHERE category_id = $1 LIMIT 1`, [categoryId]);
  return res.rowCount === 1;
}

export interface PlatformWorkStats {
  totalWorks: number;
  publishedWorks: number;
  flaggedWorks: number;
  pendingReviews: number;
  approvedReviews: number;
  rejectedReviews: number;
}

export async function getPlatformWorkStats(): Promise<PlatformWorkStats> {
  const [works, reviews] = await Promise.all([
    query<{ total: number; published: number; flagged: number }>(
      `SELECT count(*) FILTER (WHERE status <> 'deleted')::int AS total,
              count(*) FILTER (WHERE status = 'published')::int AS published,
              count(*) FILTER (WHERE status = 'flagged')::int AS flagged
         FROM works`,
    ),
    query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM work_review_requests GROUP BY status`),
  ]);
  const by = new Map(reviews.rows.map((r) => [r.status, r.n]));
  const w = works.rows[0]!;
  return {
    totalWorks: w.total,
    publishedWorks: w.published,
    flaggedWorks: w.flagged,
    pendingReviews: by.get("pending") ?? 0,
    approvedReviews: by.get("approved") ?? 0,
    rejectedReviews: by.get("rejected") ?? 0,
  };
}

export interface TopAuthor {
  authorId: string;
  publishedWorks: number;
  likesReceived: number;
}

export async function getTopAuthors(limit: number): Promise<TopAuthor[]> {
  const res = await query<{ author_id: string; published: number; likes: number }>(
    `SELECT author_id,
            count(*)::int AS published,
            COALESCE(sum(like_count), 0)::int AS likes
       FROM works WHERE status = 'published'
      GROUP BY author_id ORDER BY published DESC, likes DESC, author_id LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({ authorId: r.author_id, publishedWorks: r.published, likesReceived: r.likes }));
}
