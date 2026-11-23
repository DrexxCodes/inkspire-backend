import type { PoolClient } from "pg";
import { getPrompt, userEntryCount, type PromptRecord } from "../../repositories/prompts.repo.js";
import type { Queryable } from "../../config/postgres.js";
import { badRequest, conflict, notFound } from "../../utils/errors.js";
import { assertAcceptsEntries, promptPhase } from "./prompts.rules.js";

/**
 * Serialises entry creation for one writer on one prompt, so two simultaneous requests cannot
 * both pass the per writer limit. Released automatically when the transaction ends.
 */
export async function lockEntrySlot(client: PoolClient, promptId: string, userId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`prompt-entry:${promptId}:${userId}`]);
}

/**
 * A work may be started on, or published to, a prompt only while the prompt is open, in the
 * prompt's own category, and within the writer's entry limit.
 */
export async function assertCanEnterPrompt(
  db: Queryable,
  args: { promptId: string; userId: string; categoryId: string; excludeWorkId?: string; checkLimit?: boolean },
): Promise<PromptRecord> {
  const prompt = await getPrompt(args.promptId, db);
  if (!prompt || prompt.status !== "published") throw notFound("PROMPT_NOT_FOUND", "That prompt does not exist or is not available.");
  assertAcceptsEntries(promptPhase(prompt));
  if (prompt.categoryId !== args.categoryId) {
    throw badRequest("PROMPT_CATEGORY_MISMATCH", "This prompt belongs to a different category. Use the prompt's category.");
  }
  if (args.checkLimit !== false) {
    const used = await userEntryCount(db, prompt.id, args.userId, args.excludeWorkId);
    if (used >= prompt.maxEntriesPerUser) {
      throw conflict(
        "PROMPT_ENTRY_LIMIT",
        prompt.maxEntriesPerUser === 1
          ? "You already have an entry for this prompt."
          : `You can enter this prompt up to ${prompt.maxEntriesPerUser} times, and you already have.`,
      );
    }
  }
  return prompt;
}

/** A work that belongs to a prompt must stay in the prompt's category. */
export async function assertCategoryMatchesPrompt(db: Queryable, promptId: string | null, categoryId: string): Promise<void> {
  if (!promptId) return;
  const prompt = await getPrompt(promptId, db);
  if (prompt && prompt.categoryId !== categoryId) {
    throw badRequest("PROMPT_CATEGORY_LOCKED", "This work was written for a prompt, so it has to stay in that prompt's category.");
  }
}
