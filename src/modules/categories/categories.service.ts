import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { categoriesCol, getCategory, invalidateCategoryCache } from "../../repositories/categories.repo.js";
import { conflict, notFound } from "../../utils/errors.js";
import { slugify } from "../../utils/text.js";
import { logAdmin } from "../../services/audit.service.js";
import { categoryHasWorks } from "../../repositories/work-stats.repo.js";
import { promptsUseCategory } from "../../repositories/prompts.repo.js";

type Logger = Parameters<typeof logAdmin>[1];

const fields = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500),
  imageUrl: z.string().url().max(2000).nullable(),
  isActive: z.boolean(),
};

export const createCategorySchema = z.object({
  name: fields.name,
  description: fields.description.default(""),
  imageUrl: fields.imageUrl.optional(),
  isActive: fields.isActive.default(true),
});

export const updateCategorySchema = z
  .object({
    name: fields.name,
    description: fields.description,
    imageUrl: fields.imageUrl,
    isActive: fields.isActive,
  })
  .partial()
  .strict();

async function uniqueSlug(base: string): Promise<string> {
  const root = base || "category";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await categoriesCol().where("slug", "==", candidate).limit(1).get();
    if (taken.empty) return candidate;
  }
  return `${root}-${Date.now()}`;
}

export async function createCategory(adminId: string, input: z.output<typeof createCategorySchema>, log: Logger) {
  const slug = await uniqueSlug(slugify(input.name));
  const ref = categoriesCol().doc();
  await ref.create({
    name: input.name,
    slug,
    description: input.description,
    imageUrl: input.imageUrl ?? null,
    isActive: input.isActive,
    createdBy: adminId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  invalidateCategoryCache();
  await logAdmin({ adminId, action: "CATEGORY_CREATED", targetType: "category", targetId: ref.id, metadata: { name: input.name, slug } }, log);
  return (await getCategory(ref.id))!;
}

export async function updateCategory(adminId: string, id: string, patch: z.output<typeof updateCategorySchema>, log: Logger) {
  const existing = await getCategory(id);
  if (!existing) throw notFound("CATEGORY_NOT_FOUND", "That category does not exist.");
  // The slug is deliberately stable so shared links keep working after a rename.
  await categoriesCol().doc(id).update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  invalidateCategoryCache();
  await logAdmin({ adminId, action: "CATEGORY_UPDATED", targetType: "category", targetId: id, metadata: { patch } }, log);
  return (await getCategory(id))!;
}

export async function deleteCategory(adminId: string, id: string, log: Logger) {
  const existing = await getCategory(id);
  if (!existing) throw notFound("CATEGORY_NOT_FOUND", "That category does not exist.");
  if (await categoryHasWorks(id)) {
    throw conflict("CATEGORY_IN_USE", "This category still has works. Deactivate it instead of deleting it.");
  }
  if (await promptsUseCategory(id)) {
    throw conflict("CATEGORY_IN_USE", "This category still has prompts. Deactivate it instead of deleting it.");
  }
  await categoriesCol().doc(id).delete();
  invalidateCategoryCache();
  await logAdmin({ adminId, action: "CATEGORY_DELETED", targetType: "category", targetId: id, metadata: { name: existing.name } }, log);
}
