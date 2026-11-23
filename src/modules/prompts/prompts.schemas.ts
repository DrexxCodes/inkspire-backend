import { z } from "zod";
import { idParam } from "../../utils/validation.js";

const isoDate = z.string().datetime({ offset: true }).transform((s) => new Date(s));

const base = {
  title: z.string().trim().min(3, "Give the prompt a title.").max(140),
  description: z.string().trim().max(2000).default(""),
  categoryId: idParam,
  startsAt: isoDate,
  endsAt: isoDate,
  maxEntriesPerUser: z.number().int().min(1).max(10).default(1),
};

export const createPromptSchema = z.object(base).refine((v) => v.endsAt > v.startsAt, {
  message: "The end must be after the start.",
  path: ["endsAt"],
});

export const updatePromptSchema = z
  .object({
    title: base.title,
    description: base.description,
    categoryId: base.categoryId,
    startsAt: base.startsAt,
    endsAt: base.endsAt,
    maxEntriesPerUser: base.maxEntriesPerUser,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

export const promptListQuery = z.object({
  phase: z.enum(["upcoming", "open", "judging", "completed"]).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.string().optional(),
});

export const adminPromptListQuery = promptListQuery.extend({
  phase: z.enum(["draft", "upcoming", "open", "judging", "completed"]).optional(),
});

export const entriesQuery = z.object({
  sort: z.enum(["latest", "popular", "viewed", "discussed"]).default("latest"),
  cursor: z.string().max(1000).optional(),
  limit: z.string().optional(),
});

export const winnersSchema = z.object({
  winners: z
    .array(
      z.object({
        workId: idParam,
        placement: z.number().int().min(1).max(3),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1, "Pick at least one winner.")
    .max(3, "At most three winners.")
    .superRefine((list, ctx) => {
      if (new Set(list.map((w) => w.workId)).size !== list.length) ctx.addIssue({ code: "custom", message: "A work can only place once." });
      if (new Set(list.map((w) => w.placement)).size !== list.length) ctx.addIssue({ code: "custom", message: "Each placement can only be used once." });
    }),
});
