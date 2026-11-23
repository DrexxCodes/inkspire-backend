import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/authorize.js";
import { query } from "../../config/postgres.js";
import { listAllCategories } from "../../repositories/categories.repo.js";
import { hydrateWorks, listWorkRows, WORK_SELECT } from "../../repositories/works.repo.js";
import { getUsersByIds } from "../../repositories/users.repo.js";
import { getTopAuthors } from "../../repositories/work-stats.repo.js";
import { readStats } from "../../services/stats.service.js";
import { parse } from "../../utils/validation.js";
import { ok } from "../../utils/respond.js";
import { clampLimit } from "../../utils/pagination.js";
import { DEFAULT_POINTS, METRICS, TABLE, buildBuckets, fillSeries } from "./analytics.range.js";

const guard = [requireUser, requirePermission("viewAnalytics")];

export async function analyticsRoutes(app: FastifyInstance) {
  // Summary cards: the user total is a Firestore counter, work figures are counted in PostgreSQL.
  app.get("/summary", { preHandler: guard }, async () => {
    const s = await readStats();
    return ok({
      totalUsers: s.totalUsers,
      totalWorks: s.totalWorks,
      publishedWorks: s.publishedWorks,
      flaggedWorks: s.flaggedWorks,
      pendingReviews: s.pendingReviews,
      moderation: {
        flagged: s.flaggedWorks,
        pendingReview: s.pendingReviews,
        approved: s.approvedReviews,
        rejected: s.rejectedReviews,
      },
    });
  });

  // Daily, monthly or yearly series read from the pre aggregated PostgreSQL tables.
  app.get("/timeseries", { preHandler: guard }, async (req) => {
    const q = parse(
      z.object({
        granularity: z.enum(["daily", "monthly", "yearly"]).default("daily"),
        points: z.coerce.number().int().min(1).max(366).optional(),
      }),
      req.query,
    );
    const buckets = buildBuckets(q.granularity, q.points ?? DEFAULT_POINTS[q.granularity]);
    const { table, key, bucketSql } = TABLE[q.granularity];
    const first = q.granularity === "yearly" ? Number(buckets[0]) : buckets[0];
    const res = await query(
      `SELECT ${bucketSql} AS bucket, ${METRICS.join(", ")} FROM ${table} WHERE ${key} >= $1 ORDER BY ${key}`,
      [first],
    );
    return ok({ granularity: q.granularity, series: fillSeries(buckets, res.rows) });
  });

  app.get("/categories", { preHandler: guard }, async () => {
    const items = (await listAllCategories()).map((c) => ({
      id: c.id,
      name: c.name,
      publishedCount: Math.max(0, c.publishedCount ?? 0),
    }));
    items.sort((a, b) => b.publishedCount - a.publishedCount);
    return ok({ items });
  });

  app.get("/top-works", { preHandler: guard }, async (req) => {
    const q = parse(z.object({ by: z.enum(["views", "likes", "comments"]).default("views"), limit: z.string().optional() }), req.query);
    const col = { views: "view_count", likes: "like_count", comments: "comment_count" }[q.by];
    const works = await listWorkRows(
      `${WORK_SELECT} WHERE w.status = 'published' ORDER BY w.${col} DESC, w.id DESC LIMIT $1`,
      [clampLimit(q.limit, 10, 25)],
    );
    return ok({ items: await hydrateWorks(works, getAuthSafe(req)) });
  });

  app.get("/top-authors", { preHandler: guard }, async (req) => {
    const q = parse(z.object({ limit: z.string().optional() }), req.query);
    const top = await getTopAuthors(clampLimit(q.limit, 10, 25));
    const users = await getUsersByIds(top.map((t) => t.authorId));
    return ok({
      items: top
        .filter((t) => users.has(t.authorId))
        .map((t) => {
          const u = users.get(t.authorId)!;
          return {
            username: u.username,
            displayName: u.displayName,
            profilePhotoUrl: u.profilePhotoUrl ?? null,
            publishedWorks: t.publishedWorks,
            likesReceived: t.likesReceived,
          };
        }),
    });
  });
}

function getAuthSafe(req: Parameters<typeof getAuth>[0]) {
  return req.auth ?? null;
}
