import { db } from "../config/firebase.js";
import type { UserDoc } from "../types/domain.js";
import { NO_STATS, getOneAuthorStats, type AuthorStats } from "./work-stats.repo.js";

export const usersCol = () => db.collection("users");
export const usernamesCol = () => db.collection("usernames");

const toUser = (snap: FirebaseFirestore.DocumentSnapshot): UserDoc | null =>
  snap.exists ? ({ id: snap.id, ...snap.data() } as UserDoc) : null;

export async function getUserById(uid: string): Promise<UserDoc | null> {
  return toUser(await usersCol().doc(uid).get());
}

export async function getUserByUsername(username: string): Promise<UserDoc | null> {
  const lower = username.toLowerCase();
  const index = await usernamesCol().doc(lower).get();
  if (!index.exists) return null;
  return getUserById(index.get("uid") as string);
}

export async function getUsersByIds(ids: string[]): Promise<Map<string, UserDoc>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, UserDoc>();
  if (unique.length === 0) return out;
  const snaps = await db.getAll(...unique.map((id) => usersCol().doc(id)));
  for (const snap of snaps) {
    const user = toUser(snap);
    if (user) out.set(user.id, user);
  }
  return out;
}

/** Fields safe to show to anyone. */
export function toAuthorSummary(u: UserDoc | undefined | null) {
  if (!u) return { username: "unknown", displayName: "Unknown author", profilePhotoUrl: null, verified: false };
  return {
    username: u.username,
    displayName: u.displayName,
    profilePhotoUrl: u.profilePhotoUrl ?? null,
    verified: u.verified === true,
  };
}

/** Work totals come from PostgreSQL (see work-stats.repo), so every profile is built with them passed in. */
export function toPublicProfile(u: UserDoc, stats: AuthorStats) {
  return {
    username: u.username,
    displayName: u.displayName,
    bio: u.bio ?? "",
    profilePhotoUrl: u.profilePhotoUrl ?? null,
    coverPhotoUrl: u.coverPhotoUrl ?? null,
    avatarType: u.avatarType,
    verified: u.verified === true,
    createdAt: u.createdAt,
    stats: {
      publishedWorks: Math.max(0, stats.publishedWorks),
      likesReceived: Math.max(0, stats.likesReceived),
    },
    accountStatus: u.accountStatus,
  };
}

/** The signed in user's own view of their profile. Still never includes internal fields. */
export function toPrivateProfile(u: UserDoc, stats: AuthorStats) {
  return { ...toPublicProfile(u, stats), email: u.email ?? null, role: u.role };
}

/**
 * Convenience for single profile responses: loads the author's work totals, then builds the DTO.
 * The totals are decoration, so if PostgreSQL is unreachable the profile still loads (with zeros).
 * That matters most for /auth/me, which every sign in depends on.
 */
export async function publicProfileOf(u: UserDoc) {
  return toPublicProfile(u, await getOneAuthorStats(u.id).catch(() => NO_STATS));
}

export async function privateProfileOf(u: UserDoc) {
  return toPrivateProfile(u, await getOneAuthorStats(u.id).catch(() => NO_STATS));
}

/** All explicit category permissions for a user in one read, as categoryId -> canPost. */
export async function listCategoryPermissions(uid: string): Promise<Map<string, boolean>> {
  const snap = await usersCol().doc(uid).collection("categoryPermissions").limit(500).get();
  return new Map(snap.docs.map((d) => [d.id, d.get("canPost") === true]));
}

/** Category posting permission with the platform default as fallback. */
export async function canPostInCategory(
  uid: string,
  categoryId: string,
  defaultAllowed: boolean,
): Promise<boolean> {
  const snap = await usersCol().doc(uid).collection("categoryPermissions").doc(categoryId).get();
  if (!snap.exists) return defaultAllowed;
  return snap.get("canPost") === true;
}
