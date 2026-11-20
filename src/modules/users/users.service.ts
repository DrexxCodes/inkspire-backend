import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { usersCol } from "../../repositories/users.repo.js";
import { badRequest } from "../../utils/errors.js";
import { generateAvatarSvg } from "../../services/avatar.service.js";
import {
  ALLOWED_IMAGE_TYPES,
  removePaths,
  sniffImageType,
  uploadPublic,
} from "../../services/storage.service.js";
import { settingsService } from "../../services/settings.service.js";
import { invalidateProfile } from "../../services/profile-cache.service.js";
import type { UserDoc } from "../../types/domain.js";

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().optional(),
});

export async function updateProfile(user: UserDoc, input: z.output<typeof updateProfileSchema>) {
  const settings = await settingsService.get();
  if (input.bio !== undefined && input.bio.length > settings.maxBioLength) {
    throw badRequest("BIO_TOO_LONG", `Your bio can be at most ${settings.maxBioLength} characters.`);
  }
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.bio !== undefined) patch.bio = input.bio;
  await usersCol().doc(user.id).update(patch);
  invalidateProfile(user.id);
}

export type PhotoKind = "profile" | "cover";
const ALL_EXTENSIONS = ["jpg", "png", "webp", "svg"];

export async function savePhoto(user: UserDoc, kind: PhotoKind, buffer: Buffer): Promise<string> {
  const type = sniffImageType(buffer);
  if (!type || !ALLOWED_IMAGE_TYPES[type]) {
    throw badRequest("UNSUPPORTED_IMAGE", "Please upload a JPEG, PNG or WebP image.");
  }
  const ext = ALLOWED_IMAGE_TYPES[type]!;
  const url = await uploadPublic(`profiles/${user.id}/${kind}.${ext}`, buffer, type);
  // Drop the previous file if the extension changed (best effort).
  await removePaths(
    ALL_EXTENSIONS.filter((e) => e !== ext).map((e) => `profiles/${user.id}/${kind}.${e}`),
  ).catch(() => undefined);

  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (kind === "profile") {
    patch.profilePhotoUrl = url;
    patch.avatarType = "uploaded";
  } else {
    patch.coverPhotoUrl = url;
  }
  await usersCol().doc(user.id).update(patch);
  invalidateProfile(user.id);
  return url;
}

/** Removing a profile photo goes back to the deterministic DiceBear avatar. */
export async function removePhoto(user: UserDoc, kind: PhotoKind): Promise<string | null> {
  await removePaths(ALL_EXTENSIONS.map((e) => `profiles/${user.id}/${kind}.${e}`)).catch(() => undefined);
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  let url: string | null = null;
  if (kind === "profile") {
    url = await uploadPublic(`profiles/${user.id}/profile.svg`, generateAvatarSvg(user.username), "image/svg+xml");
    patch.profilePhotoUrl = url;
    patch.avatarType = "dicebear";
  } else {
    patch.coverPhotoUrl = null;
  }
  await usersCol().doc(user.id).update(patch);
  invalidateProfile(user.id);
  return url;
}
