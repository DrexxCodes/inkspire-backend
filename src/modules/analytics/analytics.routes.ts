import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/authorize.js";
import { query } from "../../config/postgres.js";
import { listAllCategories } from "../../repositories/categories.repo.js";
import { worksCol, hydrateWorks } from "../../repositories/works.repo.js";
import { usersCol } from "../../repositories/users.repo.js";
import { readStats } from "../../services/stats.service.js";
import { parse } from "../../utils/validation.js";
import { ok } from "../../utils/respond.js";
import { clampLimit } from "../../utils/pagination.js";
import type { Doc } from "../../types/domain.js";
import { DEFAULT_POINTS, METRICS, TABLE, buildBuckets, fillSeries } from "./analytics.range.js";

const guard = [requireUser, requirePermission("viewAnalytics")];

export async function analyticsRoutes(app: FastifyInstance) {
  // Summary cards and the moderation overview come from one counter document.
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
    const field = { views: "viewCount", likes: "likeCount", comments: "commentCount" }[q.by];
    const snap = await worksCol().where("status", "==", "published").orderBy(field, "desc").limit(clampLimit(q.limit, 10, 25)).get();
    const works = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Doc);
    return ok({ items: await hydrateWorks(works, getAuthSafe(req)) });
  });

  app.get("/top-authors", { preHandler: guard }, async (req) => {
    const q = parse(z.object({ limit: z.string().optional() }), req.query);
    const snap = await usersCol().orderBy("publishedWorkCount", "desc").limit(clampLimit(q.limit, 10, 25)).get();
    return ok({
      items: snap.docs
        .filter((d) => (d.get("publishedWorkCount") ?? 0) > 0)
        .map((d) => ({
          username: d.get("username"),
          displayName: d.get("displayName"),
          profilePhotoUrl: d.get("profilePhotoUrl") ?? null,
          publishedWorks: d.get("publishedWorkCount") ?? 0,
          likesReceived: d.get("likesReceived") ?? 0,
        })),
    });
  });
}

function getAuthSafe(req: Parameters<typeof getAuth>[0]) {
  return req.auth ?? null;
}
