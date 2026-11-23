import { z } from "zod";
import { idParam } from "../../utils/validation.js";

export const title = z.string().trim().min(1, "Give your work a title.").max(200);
export const description = z.string().trim().max(1000);
export const coverUrl = z.string().url().max(2000).nullable();

export const createWorkSchema = z.object({
  title,
  description: description.default(""),
  categoryId: z.string().min(1).max(128),
  coverImageUrl: coverUrl.optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  content: z.string().min(1, "A work needs some content."),
  publish: z.boolean().default(false),
  /** Write this work for a prompt. Must be open, and the category must be the prompt's own. */
  promptId: idParam.optional(),
  /** Client generated. A retried request with the same key returns the same work. */
  idempotencyKey: z.string().min(8).max(100).optional(),
});

export const saveRevisionSchema = z.object({
  title,
  description: description.default(""),
  categoryId: z.string().min(1).max(128),
  coverImageUrl: coverUrl.optional(),
  content: z.string().min(1, "A work needs some content."),
  changeReason: z.string().trim().max(300).optional(),
  /** false saves a checkpoint without replacing what readers currently see. */
  makeCurrent: z.boolean().default(true),
  basedOnRevisionId: z.string().max(40).optional(),
  /** Publish right after saving (only meaningful when makeCurrent is true). */
  publish: z.boolean().default(false),
});

export const autosaveSchema = z.object({
  title: z.string().trim().max(200).default(""),
  description: description.default(""),
  categoryId: z.string().max(128).default(""),
  coverImageUrl: coverUrl.optional(),
  content: z.string().min(1),
  basedOnRevisionId: z.string().max(40).optional(),
});

export const listQuerySchema = z.object({
  cursor: z.string().max(1000).optional(),
  limit: z.string().optional(),
  category: z.string().max(128).optional(),
  sort: z.enum(["latest", "popular", "viewed", "discussed"]).default("latest"),
  q: z.string().trim().max(100).optional(),
  /** Only the entries of one prompt. */
  prompt: idParam.optional(),
});

export const chunkQuerySchema = z.object({
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  revisionId: z.string().max(40).optional(),
});
