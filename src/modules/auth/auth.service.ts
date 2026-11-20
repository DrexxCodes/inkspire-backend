import { FieldValue } from "firebase-admin/firestore";
import type { DecodedIdToken } from "firebase-admin/auth";
import { z } from "zod";
import { db } from "../../config/firebase.js";
import { env } from "../../config/env.js";
import type { UserDoc } from "../../types/domain.js";
import { AppError, badRequest, conflict, forbidden } from "../../utils/errors.js";
import { RESERVED_USERNAMES, USERNAME_PATTERN } from "../../utils/text.js";
import { generateAvatarSvg } from "../../services/avatar.service.js";
import { uploadPublic } from "../../services/storage.service.js";
import { settingsService } from "../../services/settings.service.js";
import { statsIncrement, statsRef } from "../../services/stats.service.js";
import { track } from "../../services/analytics.service.js";
import { getUserById, usernamesCol, usersCol } from "../../repositories/users.repo.js";
import { invalidateProfile } from "../../services/profile-cache.service.js";

type Logger = Parameters<typeof track>[1] & { warn: (o: object, m: string) => void };

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_PATTERN, "Use 3 to 24 lowercase letters, numbers or underscores."),
  displayName: z.string().trim().min(1).max(60).optional(),
});

export function assertUsernameUsable(username: string) {
  if (RESERVED_USERNAMES.has(username)) {
    throw conflict("USERNAME_TAKEN", "That username is not available.");
  }
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  if (!USERNAME_PATTERN.test(username) || RESERVED_USERNAMES.has(username)) return false;
  return !(await usernamesCol().doc(username).get()).exists;
}

/** Generates and stores the deterministic DiceBear avatar, returning its public URL. */
async function createDefaultAvatar(uid: string, seed: string): Promise<string> {
  return uploadPublic(`profiles/${uid}/profile.svg`, generateAvatarSvg(seed), "image/svg+xml");
}

export async function registerProfile(
  token: DecodedIdToken,
  input: z.output<typeof registerSchema>,
  log: Logger,
): Promise<UserDoc> {
  const uid = token.uid;

  // Idempotent: a retried registration returns the existing profile.
  const existing = await getUserById(uid);
  if (existing) return existing;

  const email = token.email?.toLowerCase() ?? null;
  const isSuperAdmin = !!email && token.email_verified === true && env.superAdminEmails.has(email);

  const settings = await settingsService.get();
  if (!settings.allowRegistration && !isSuperAdmin) {
    throw forbidden("REGISTRATION_CLOSED", "New registrations are currently closed.");
  }

  assertUsernameUsable(input.username);
  if (!(await isUsernameAvailable(input.username))) {
    throw conflict("USERNAME_TAKEN", "That username is already taken.");
  }

  // Stable seed: the username. Storage trouble must not block sign up, so fall back to no URL
  // and let /auth/me repair it later.
  let profilePhotoUrl: string | null = null;
  try {
    profilePhotoUrl = await createDefaultAvatar(uid, input.username);
  } catch (err) {
    log.warn({ uid, err: (err as Error).message }, "default avatar upload failed (is the Supabase bucket created and public?). The web app falls back to a generated avatar.");
  }

  const profile = {
    username: input.username,
    usernameLower: input.username,
    displayName: input.displayName ?? input.username,
    bio: "",
    email,
    profilePhotoUrl,
    coverPhotoUrl: null,
    avatarType: "dicebear" as const,
    role: isSuperAdmin ? ("super_admin" as const) : ("user" as const),
    accountStatus: "active" as const,
    publishedWorkCount: 0,
    likesReceived: 0,
  };

  try {
    await db.runTransaction(async (tx) => {
      const usernameRef = usernamesCol().doc(input.username);
      const userRef = usersCol().doc(uid);
      const [usernameSnap, userSnap] = await Promise.all([tx.get(usernameRef), tx.get(userRef)]);
      if (usernameSnap.exists) throw conflict("USERNAME_TAKEN", "That username is already taken.");
      if (userSnap.exists) return;
      tx.create(usernameRef, { uid, createdAt: FieldValue.serverTimestamp() });
      tx.create(userRef, { ...profile, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.set(statsRef(), statsIncrement({ totalUsers: 1 }), { merge: true });
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw badRequest("REGISTRATION_FAILED", "We could not create your profile. Please try again.");
  }

  track({ eventId: `signup:${uid}`, metric: "signups" }, log);

  const created = await getUserById(uid);
  if (!created) throw badRequest("REGISTRATION_FAILED", "We could not create your profile. Please try again.");
  return created;
}

/** Repairs a missing default avatar (for example if storage was down during sign up). */
export async function ensureAvatar(profile: UserDoc, log: Logger): Promise<UserDoc> {
  if (profile.avatarType !== "dicebear" || profile.profilePhotoUrl) return profile;
  try {
    const url = await createDefaultAvatar(profile.id, profile.username);
    await usersCol().doc(profile.id).update({ profilePhotoUrl: url, updatedAt: FieldValue.serverTimestamp() });
    invalidateProfile(profile.id);
    return { ...profile, profilePhotoUrl: url };
  } catch (err) {
    log.warn({ uid: profile.id, err: (err as Error).message }, "avatar repair failed");
    return profile;
  }
}
