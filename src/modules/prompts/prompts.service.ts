import { pool, withTransaction } from "../../config/postgres.js";
import type { AuthContext } from "../../types/domain.js";
import { getCategory, getCategoryMap } from "../../repositories/categories.repo.js";
import { getUsersByIds, toPublicProfile } from "../../repositories/users.repo.js";
import { getAuthorStats, statsOrEmpty } from "../../repositories/work-stats.repo.js";
import { hydrateWorks } from "../../repositories/works.repo.js";
import {
  entryCounts,
  getPrompt,
  listWinners,
  lockPrompt,
  mapPrompt,
  userEntryCounts,
  type PromptRecord,
} from "../../repositories/prompts.repo.js";
import { logAdmin } from "../../services/audit.service.js";
import { notify } from "../../services/notifications.service.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { clampLimit, decodeKey, keysetClause, sliceKeyset } from "../../utils/pagination.js";
import { newId } from "../../utils/ids.js";
import { serialize } from "../../utils/serialize.js";
import { canPickWinners, isPublic, promptPhase, type PromptPhase } from "./prompts.rules.js";
import type { z } from "zod";
import type { createPromptSchema, updatePromptSchema, winnersSchema } from "./prompts.schemas.js";

type Logger = Parameters<typeof logAdmin>[1];

/* --------------------------------- DTO building --------------------------------- */

/**
 * Builds the response for a page of prompts with one batch per data source: entry counts, the
 * viewer's own counts, categories, and (for prompts with announced winners) the winning works
 * together with each winner's profile.
 */
async function buildDtos(prompts: PromptRecord[], viewer: AuthContext | null | undefined, admin: boolean) {
  const ids = prompts.map((p) => p.id);
  const announced = prompts.filter((p) => p.winnersAnnouncedAt).map((p) => p.id);
  const [counts, mine, cats, winners] = await Promise.all([
    entryCounts(ids),
    viewer ? userEntryCounts(viewer.uid, ids) : Promise.resolve(new Map<string, number>()),
    getCategoryMap(prompts.map((p) => p.categoryId)),
    // Admins see winners as soon as they are picked, the public only once announced and still readable.
    listWinners(admin ? ids : announced, { publicOnly: !admin }),
  ]);

  const winnerWorks = await hydrateWorks(winners.map((w) => w.work), viewer);
  const authorIds = [...new Set(winners.map((w) => w.work.authorId))];
  const [users, stats] = await Promise.all([getUsersByIds(authorIds), getAuthorStats(authorIds).catch(() => new Map())]);
  const byPrompt = new Map<string, unknown[]>();
  winners.forEach((w, i) => {
    const u = users.get(w.work.authorId);
    const entry = {
      placement: w.placement,
      note: w.note,
      selectedAt: w.selectedAt,
      work: winnerWorks[i],
      // The winner's full public profile, for the billboard spotlight.
      profile: u && u.accountStatus !== "blocked" ? toPublicProfile(u, statsOrEmpty(stats, u.id)) : null,
    };
    const list = byPrompt.get(w.promptId) ?? [];
    list.push(entry);
    byPrompt.set(w.promptId, list);
  });

  return prompts.map((p) => {
    const phase = promptPhase(p);
    const cat = cats.get(p.categoryId);
    return serialize({
      id: p.id,
      title: p.title,
      description: p.description,
      category: cat
        ? { id: cat.id, name: cat.name as string, slug: cat.slug as string }
        : { id: p.categoryId, name: "Uncategorised", slug: "uncategorised" },
      phase,
      status: admin ? p.status : undefined,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      maxEntriesPerUser: p.maxEntriesPerUser,
      winnersAnnouncedAt: p.winnersAnnouncedAt,
      publishedAt: p.publishedAt,
      createdAt: admin ? p.createdAt : undefined,
      entryCount: counts.get(p.id) ?? 0,
      viewer: viewer ? { entries: mine.get(p.id) ?? 0, canEnter: phase === "open" && (mine.get(p.id) ?? 0) < p.maxEntriesPerUser } : undefined,
      winners: byPrompt.get(p.id) ?? [],
    });
  });
}

/* ----------------------------------- Public reads ----------------------------------- */

const PHASE_SQL: Record<string, string> = {
  upcoming: `status = 'published' AND winners_announced_at IS NULL AND starts_at > inkspire_now()`,
  open: `status = 'published' AND winners_announced_at IS NULL AND starts_at <= inkspire_now() AND ends_at > inkspire_now()`,
  judging: `status = 'published' AND winners_announced_at IS NULL AND ends_at <= inkspire_now()`,
  completed: `status = 'published' AND winners_announced_at IS NOT NULL`,
  draft: `status = 'draft'`,
};

async function listPrompts(
  params: { phase?: string; cursor?: string; limit?: string },
  viewer: AuthContext | null | undefined,
  admin: boolean,
) {
  const limit = clampLimit(params.limit, 12, 30);
  const values: unknown[] = [];
  const where: string[] = [];
  if (!admin) where.push(`status = 'published'`);
  if (params.phase) where.push(`(${PHASE_SQL[params.phase]})`);
  const after = keysetClause(["starts_at", "id"], ["ts", "text"], "desc", decodeKey(params.cursor, ["ts", "text"]), values);
  if (after) where.push(after);
  values.push(limit + 1);
  const res = await pool.query(
    `SELECT * FROM prompts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY starts_at DESC, id DESC LIMIT $${values.length}`,
    values,
  );
  const page = sliceKeyset(res.rows.map(mapPrompt), limit, (p) => [p.startsAt, p.id]);
  return { items: await buildDtos(page.rows, viewer, admin), nextCursor: page.nextCursor };
}

export const listPublicPrompts = (params: { phase?: string; cursor?: string; limit?: string }, viewer?: AuthContext | null) =>
  listPrompts(params, viewer, false);

export const listAdminPrompts = (params: { phase?: string; cursor?: string; limit?: string }, viewer: AuthContext) =>
  listPrompts(params, viewer, true);

/** Drafts look exactly like missing prompts to everyone but admins. */
export async function getPromptDto(id: string, viewer: AuthContext | null | undefined, admin = false) {
  const prompt = await getPrompt(id);
  if (!prompt || (!admin && !isPublic(promptPhase(prompt)))) throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist.");
  return (await buildDtos([prompt], viewer, admin))[0]!;
}

/**
 * Everything the billboard shows in one request: what is open now, what is coming, what is being
 * judged, and the latest finished prompts with their winners and winner profiles.
 */
export async function getBillboard(viewer?: AuthContext | null) {
  const pick = async (phase: string, limit: number, order: string) => {
    const res = await pool.query(`SELECT * FROM prompts WHERE ${PHASE_SQL[phase]} ORDER BY ${order} LIMIT $1`, [limit]);
    return buildDtos(res.rows.map(mapPrompt), viewer, false);
  };
  const [open, upcoming, judging, completed] = await Promise.all([
    pick("open", 10, "ends_at ASC, id ASC"),
    pick("upcoming", 5, "starts_at ASC, id ASC"),
    pick("judging", 5, "ends_at DESC, id DESC"),
    pick("completed", 6, "winners_announced_at DESC, id DESC"),
  ]);
  return { open, upcoming, judging, completed };
}

/* ------------------------------------- Admin ------------------------------------- */

async function assertCategoryExists(categoryId: string) {
  if (!(await getCategory(categoryId))) throw notFound("CATEGORY_NOT_FOUND", "That category does not exist.");
}

export async function createPrompt(actor: AuthContext, input: z.output<typeof createPromptSchema>, log: Logger) {
  await assertCategoryExists(input.categoryId);
  const id = newId();
  await pool.query(
    `INSERT INTO prompts (id, title, description, category_id, starts_at, ends_at, max_entries_per_user, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.title, input.description, input.categoryId, input.startsAt, input.endsAt, input.maxEntriesPerUser, actor.uid],
  );
  await logAdmin({ adminId: actor.uid, action: "PROMPT_CREATED", targetType: "prompt", targetId: id, metadata: { title: input.title } }, log);
  return getPromptDto(id, actor, true);
}

async function entryTotal(db: Parameters<typeof getPrompt>[1], promptId: string): Promise<number> {
  const res = await db!.query(`SELECT count(*)::int AS n FROM works WHERE prompt_id = $1 AND status <> 'deleted'`, [promptId]);
  return res.rows[0].n as number;
}

export async function updatePrompt(actor: AuthContext, id: string, patch: z.output<typeof updatePromptSchema>, log: Logger) {
  if (patch.categoryId) await assertCategoryExists(patch.categoryId);
  await withTransaction(async (c) => {
    const cur = await lockPrompt(c, id);
    if (!cur) throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist.");
    const phase = promptPhase(cur);
    const next = {
      title: patch.title ?? cur.title,
      description: patch.description ?? cur.description,
      categoryId: patch.categoryId ?? cur.categoryId,
      startsAt: patch.startsAt ?? cur.startsAt,
      endsAt: patch.endsAt ?? cur.endsAt,
      max: patch.maxEntriesPerUser ?? cur.maxEntriesPerUser,
    };
    if (next.endsAt <= next.startsAt) throw badRequest("INVALID_WINDOW", "The end must be after the start.");

    if (phase === "completed" && (patch.categoryId || patch.startsAt || patch.endsAt || patch.maxEntriesPerUser)) {
      throw conflict("PROMPT_COMPLETED", "Winners were already announced. Only the title and description can change now.");
    }
    if (patch.categoryId && patch.categoryId !== cur.categoryId && (await entryTotal(c, id)) > 0) {
      throw conflict("PROMPT_HAS_ENTRIES", "This prompt already has entries, so its category can no longer change.");
    }
    await c.query(
      `UPDATE prompts SET title = $2, description = $3, category_id = $4, starts_at = $5, ends_at = $6,
              max_entries_per_user = $7, updated_at = inkspire_now() WHERE id = $1`,
      [id, next.title, next.description, next.categoryId, next.startsAt, next.endsAt, next.max],
    );
  });
  await logAdmin({ adminId: actor.uid, action: "PROMPT_UPDATED", targetType: "prompt", targetId: id, metadata: { fields: Object.keys(patch) } }, log);
  return getPromptDto(id, actor, true);
}

export async function publishPrompt(actor: AuthContext, id: string, log: Logger) {
  await withTransaction(async (c) => {
    const cur = await lockPrompt(c, id);
    if (!cur) throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist.");
    if (cur.status === "published") return; // idempotent
    if (cur.endsAt <= new Date()) throw badRequest("PROMPT_ALREADY_ENDED", "This prompt's window has already ended. Move the dates first.");
    await assertCategoryExists(cur.categoryId);
    await c.query(`UPDATE prompts SET status = 'published', published_at = COALESCE(published_at, inkspire_now()), updated_at = inkspire_now() WHERE id = $1`, [id]);
  });
  await logAdmin({ adminId: actor.uid, action: "PROMPT_PUBLISHED", targetType: "prompt", targetId: id }, log);
  return getPromptDto(id, actor, true);
}

/** Back to draft. Only while nobody has written for it yet, so no one's entry ever loses its tag. */
export async function unpublishPrompt(actor: AuthContext, id: string, log: Logger) {
  await withTransaction(async (c) => {
    const cur = await lockPrompt(c, id);
    if (!cur) throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist.");
    if (cur.status === "draft") return;
    if (cur.winnersAnnouncedAt) throw conflict("PROMPT_COMPLETED", "Winners were already announced, so this prompt cannot go back to draft.");
    if ((await entryTotal(c, id)) > 0) throw conflict("PROMPT_HAS_ENTRIES", "Writers already have entries, so this prompt cannot go back to draft.");
    await c.query(`UPDATE prompts SET status = 'draft', updated_at = inkspire_now() WHERE id = $1`, [id]);
  });
  await logAdmin({ adminId: actor.uid, action: "PROMPT_UNPUBLISHED", targetType: "prompt", targetId: id }, log);
  return getPromptDto(id, actor, true);
}

export async function deletePrompt(actor: AuthContext, id: string, log: Logger) {
  await withTransaction(async (c) => {
    const cur = await lockPrompt(c, id);
    if (!cur) throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist.");
    if ((await entryTotal(c, id)) > 0) throw conflict("PROMPT_HAS_ENTRIES", "This prompt has entries, so it cannot be deleted.");
    await c.query(`DELETE FROM prompts WHERE id = $1`, [id]);
  });
  await logAdmin({ adminId: actor.uid, action: "PROMPT_DELETED", targetType: "prompt", targetId: id }, log);
}

/**
 * Chooses (or corrects) the winners. Allowed once the window has ended. The first call announces
 * the results; later calls replace them. Only published, public entries of this very prompt qualify.
 */
export async function setWinners(actor: AuthContext, id: string, input: z.output<typeof winnersSchema>, log: Logger) {
  const { newlyAwarded } = await withTransaction(async (c) => {
    const cur = await lockPrompt(c, id);
    if (!cur) throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist.");
    const phase: PromptPhase = promptPhase(cur);
    if (!canPickWinners(phase)) {
      throw conflict("PROMPT_NOT_ENDED", "Winners can only be chosen after the prompt has ended.");
    }
    const ids = input.winners.map((w) => w.workId);
    const eligible = await c.query(
      `SELECT id, author_id, title FROM works
        WHERE prompt_id = $1 AND id = ANY($2::text[]) AND status = 'published' AND visibility = 'public' FOR SHARE`,
      [id, ids],
    );
    if (eligible.rowCount !== ids.length) {
      throw badRequest("INVALID_WINNER", "Every winner must be a published, public entry of this prompt.");
    }
    const authors = new Map(eligible.rows.map((r) => [r.id as string, { authorId: r.author_id as string, title: r.title as string }]));
    const before = await c.query(`SELECT work_id FROM prompt_winners WHERE prompt_id = $1`, [id]);
    const had = new Set(before.rows.map((r) => r.work_id as string));

    await c.query(`DELETE FROM prompt_winners WHERE prompt_id = $1`, [id]);
    for (const w of input.winners) {
      await c.query(
        `INSERT INTO prompt_winners (prompt_id, work_id, placement, note, selected_by) VALUES ($1, $2, $3, $4, $5)`,
        [id, w.workId, w.placement, w.note ?? null, actor.uid],
      );
    }
    await c.query(`UPDATE prompts SET winners_announced_at = COALESCE(winners_announced_at, inkspire_now()), updated_at = inkspire_now() WHERE id = $1`, [id]);

    return {
      newlyAwarded: input.winners
        .filter((w) => !had.has(w.workId))
        .map((w) => ({ workId: w.workId, placement: w.placement, ...authors.get(w.workId)!, promptTitle: cur.title })),
    };
  });

  await logAdmin(
    { adminId: actor.uid, action: "PROMPT_WINNERS_ANNOUNCED", targetType: "prompt", targetId: id, metadata: { winners: input.winners } },
    log,
  );
  const label = ["", "first place", "second place", "third place"];
  for (const a of newlyAwarded) {
    await notify(
      a.authorId,
      { type: "PROMPT_WON", title: `You won ${label[a.placement]}!`, body: `"${a.title}" placed in the prompt "${a.promptTitle}".`, workId: a.workId },
      log,
    );
  }
  return getPromptDto(id, actor, true);
}
