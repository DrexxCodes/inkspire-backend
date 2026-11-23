import { pool, query, type Queryable } from "../config/postgres.js";
import { mapWork, type WorkRecord } from "./works.repo.js";

export type PromptStatus = "draft" | "published";

export interface PromptRecord {
  id: string;
  title: string;
  description: string;
  categoryId: string;
  status: PromptStatus;
  startsAt: Date;
  endsAt: Date;
  maxEntriesPerUser: number;
  winnersAnnouncedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mapPrompt(r: Row): PromptRecord {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    categoryId: r.category_id,
    status: r.status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    maxEntriesPerUser: r.max_entries_per_user,
    winnersAnnouncedAt: r.winners_announced_at ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at ?? null,
  };
}

export async function getPrompt(id: string, db: Queryable = pool): Promise<PromptRecord | null> {
  const res = await db.query(`SELECT * FROM prompts WHERE id = $1`, [id]);
  return res.rows[0] ? mapPrompt(res.rows[0]) : null;
}

export async function lockPrompt(db: Queryable, id: string): Promise<PromptRecord | null> {
  const res = await db.query(`SELECT * FROM prompts WHERE id = $1 FOR UPDATE`, [id]);
  return res.rows[0] ? mapPrompt(res.rows[0]) : null;
}

export async function promptsUseCategory(categoryId: string): Promise<boolean> {
  const res = await query(`SELECT 1 FROM prompts WHERE category_id = $1 LIMIT 1`, [categoryId]);
  return res.rowCount === 1;
}

/** promptId -> number of published, public entries (what readers can open). */
export async function entryCounts(promptIds: string[], db: Queryable = pool): Promise<Map<string, number>> {
  if (promptIds.length === 0) return new Map();
  const res = await db.query(
    `SELECT prompt_id, count(*)::int AS n FROM works
      WHERE prompt_id = ANY($1::text[]) AND status = 'published' AND visibility = 'public' GROUP BY prompt_id`,
    [promptIds],
  );
  return new Map(res.rows.map((r) => [r.prompt_id as string, r.n as number]));
}

/** How many entries one writer already has on a prompt (drafts included, deleted ones not). */
export async function userEntryCount(db: Queryable, promptId: string, userId: string, excludeWorkId?: string): Promise<number> {
  const res = await db.query(
    `SELECT count(*)::int AS n FROM works
      WHERE prompt_id = $1 AND author_id = $2 AND status <> 'deleted' AND ($3::text IS NULL OR id <> $3)`,
    [promptId, userId, excludeWorkId ?? null],
  );
  return res.rows[0].n as number;
}

export async function userEntryCounts(userId: string, promptIds: string[]): Promise<Map<string, number>> {
  if (promptIds.length === 0) return new Map();
  const res = await query(
    `SELECT prompt_id, count(*)::int AS n FROM works
      WHERE author_id = $1 AND prompt_id = ANY($2::text[]) AND status <> 'deleted' GROUP BY prompt_id`,
    [userId, promptIds],
  );
  return new Map(res.rows.map((r) => [r.prompt_id as string, r.n as number]));
}

export interface WinnerRecord {
  promptId: string;
  placement: number;
  note: string | null;
  selectedAt: Date;
  work: WorkRecord;
}

/**
 * Winners of the given prompts, best placement first. Public callers only get works readers can
 * still open (a winner that was later flagged or deleted drops out of public view).
 */
export async function listWinners(promptIds: string[], opts: { publicOnly: boolean }, db: Queryable = pool): Promise<WinnerRecord[]> {
  if (promptIds.length === 0) return [];
  const res = await db.query(
    `SELECT w.*, p.title AS prompt_title, pw.placement AS prompt_placement,
            pw.prompt_id AS winner_prompt_id, pw.note AS winner_note, pw.selected_at AS winner_selected_at
       FROM prompt_winners pw
       JOIN works w ON w.id = pw.work_id
       LEFT JOIN prompts p ON p.id = w.prompt_id AND p.status = 'published'
      WHERE pw.prompt_id = ANY($1::text[])
        ${opts.publicOnly ? `AND w.status = 'published' AND w.visibility = 'public'` : ""}
      ORDER BY pw.prompt_id, pw.placement`,
    [promptIds],
  );
  return res.rows.map((r) => ({
    promptId: r.winner_prompt_id,
    placement: r.prompt_placement,
    note: r.winner_note ?? null,
    selectedAt: r.winner_selected_at,
    work: mapWork(r),
  }));
}
