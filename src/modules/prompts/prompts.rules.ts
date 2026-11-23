import type { PromptStatus } from "../../repositories/prompts.repo.js";
import { conflict } from "../../utils/errors.js";

/**
 * Pure prompt rules. No database access, so the lifecycle can be tested exhaustively.
 *
 *   draft      only admins see it
 *   upcoming   published, the window has not started
 *   open       published, inside the window: writers can enter
 *   judging    the window ended, winners not chosen yet
 *   completed  winners chosen and announced
 */
export type PromptPhase = "draft" | "upcoming" | "open" | "judging" | "completed";

export interface PromptTiming {
  status: PromptStatus;
  startsAt: Date;
  endsAt: Date;
  winnersAnnouncedAt: Date | null;
}

export function promptPhase(p: PromptTiming, now: Date = new Date()): PromptPhase {
  if (p.status === "draft") return "draft";
  if (p.winnersAnnouncedAt) return "completed";
  if (now < p.startsAt) return "upcoming";
  if (now < p.endsAt) return "open";
  return "judging";
}

/** Entries can only be started or published while the prompt is open. */
export const acceptsEntries = (phase: PromptPhase) => phase === "open";

/** Winners are chosen once the window has ended, and can be corrected afterwards. */
export const canPickWinners = (phase: PromptPhase) => phase === "judging" || phase === "completed";

export const isPublic = (phase: PromptPhase) => phase !== "draft";

/** Why a prompt is not taking entries, as an error the writer can act on. */
export function assertAcceptsEntries(phase: PromptPhase): void {
  if (phase === "open") return;
  if (phase === "upcoming") throw conflict("PROMPT_NOT_STARTED", "This prompt has not opened yet.");
  throw conflict("PROMPT_CLOSED", "This prompt is closed, so new entries are no longer accepted.");
}

export const PLACEMENT_LABEL: Record<number, string> = { 1: "Winner", 2: "Runner-up", 3: "Third place" };
