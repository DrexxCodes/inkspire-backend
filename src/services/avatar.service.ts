import { createAvatar } from "@dicebear/core";
import { lorelei } from "@dicebear/collection";

/**
 * DiceBear is installed locally (@dicebear/core + @dicebear/collection) so rendering a profile
 * never depends on a remote avatar API. The seed is stable, so the same user always gets the
 * same avatar.
 */
export function generateAvatarSvg(seed: string): string {
  return createAvatar(lorelei, {
    seed,
    radius: 50,
    backgroundColor: ["dbe7ff", "e9defa", "ffe9c7", "d6f5e3", "fde0e0"],
  }).toString();
}
