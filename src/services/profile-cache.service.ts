import type { UserDoc } from "../types/domain.js";
import { getUserById } from "../repositories/users.repo.js";

/**
 * Tiny per process cache of user profiles used by request authentication. Short lived so a role
 * or status change takes effect almost immediately, and explicitly invalidated by the admin
 * module on the instance that made the change.
 */
const TTL_MS = 10_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { profile: UserDoc | null; expiresAt: number }>();

export async function getCachedProfile(uid: string): Promise<UserDoc | null> {
  const hit = cache.get(uid);
  if (hit && hit.expiresAt > Date.now()) return hit.profile;
  const profile = await getUserById(uid);
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(uid, { profile, expiresAt: Date.now() + TTL_MS });
  return profile;
}

export const invalidateProfile = (uid: string) => cache.delete(uid);
