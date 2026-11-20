import { db } from "../config/firebase.js";
import type { UserDoc } from "../types/domain.js";

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
  if (!u) return { username: "unknown", displayName: "Unknown author", profilePhotoUrl: null };
  return { username: u.username, displayName: u.displayName, profilePhotoUrl: u.profilePhotoUrl ?? null };
}

export function toPublicProfile(u: UserDoc) {
  return {
    username: u.username,
    displayName: u.displayName,
    bio: u.bio ?? "",
    profilePhotoUrl: u.profilePhotoUrl ?? null,
    coverPhotoUrl: u.coverPhotoUrl ?? null,
    avatarType: u.avatarType,
    createdAt: u.createdAt,
    stats: {
      publishedWorks: Math.max(0, u.publishedWorkCount ?? 0),
      likesReceived: Math.max(0, u.likesReceived ?? 0),
    },
    accountStatus: u.accountStatus,
  };
}

/** The signed in user's own view of their profile. Still never includes internal fields. */
export function toPrivateProfile(u: UserDoc) {
  return { ...toPublicProfile(u), email: u.email ?? null, role: u.role };
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
