import { db } from "../config/firebase.js";
import type { Doc } from "../types/domain.js";

export const categoriesCol = () => db.collection("categories");

const CACHE_TTL_MS = 60_000;
let cache: { items: Doc[]; expiresAt: number } | null = null;

export const invalidateCategoryCache = () => {
  cache = null;
};

/** The category list is small and read constantly, so it is cached briefly. */
export async function listAllCategories(): Promise<Doc[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.items;
  const snap = await categoriesCol().orderBy("name").limit(200).get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Doc);
  cache = { items, expiresAt: Date.now() + CACHE_TTL_MS };
  return items;
}

export async function getCategory(id: string): Promise<Doc | null> {
  const found = (await listAllCategories()).find((c) => c.id === id);
  if (found) return found;
  const snap = await categoriesCol().doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Doc) : null;
}

export async function getCategoryMap(ids: string[]): Promise<Map<string, Doc>> {
  const all = await listAllCategories();
  const map = new Map(all.map((c) => [c.id, c]));
  const out = new Map<string, Doc>();
  for (const id of new Set(ids)) {
    const c = map.get(id);
    if (c) out.set(id, c);
  }
  return out;
}

export const toCategoryDto = (c: Doc, includeCounts = false) => ({
  id: c.id,
  name: c.name,
  slug: c.slug,
  description: c.description ?? "",
  imageUrl: c.imageUrl ?? null,
  isActive: c.isActive !== false,
  ...(includeCounts ? { publishedCount: Math.max(0, c.publishedCount ?? 0) } : {}),
});
