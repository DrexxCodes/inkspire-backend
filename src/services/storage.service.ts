import { supabase } from "../config/supabase.js";
import { env } from "../config/env.js";

const bucket = () => supabase.storage.from(env.SUPABASE_STORAGE_BUCKET);

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Confirms the bytes really are the claimed image type, not just a trusted header. */
export function sniffImageType(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  return null;
}

export async function uploadPublic(path: string, body: Buffer | string, contentType: string): Promise<string> {
  const { error } = await bucket().upload(path, body, { contentType, upsert: true, cacheControl: "3600" });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  // A version query keeps browsers from showing a stale image after a replacement.
  return `${bucket().getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
}

/** Removes every object under a folder prefix, e.g. `works/abc/`. Best effort. */
export async function deletePrefix(prefix: string): Promise<void> {
  const folder = prefix.replace(/\/$/, "");
  const { data, error } = await bucket().list(folder, { limit: 1000 });
  if (error || !data?.length) return;
  const paths: string[] = [];
  for (const item of data) {
    if (item.id) paths.push(`${folder}/${item.name}`);
    else await deletePrefix(`${folder}/${item.name}`);
  }
  if (paths.length) await bucket().remove(paths);
}

export async function removePaths(paths: string[]): Promise<void> {
  if (paths.length) await bucket().remove(paths);
}
