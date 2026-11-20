import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../config/firebase.js";
import { env } from "../config/env.js";
import { MAX_CHUNK_THRESHOLD_BYTES } from "./chunking.js";

const full = z.object({
  contentChunkThresholdBytes: z.number().int().min(16_384).max(MAX_CHUNK_THRESHOLD_BYTES),
  maxWorkSizeBytes: z.number().int().min(1_024).max(50_000_000),
  maxCommentLength: z.number().int().min(1).max(10_000),
  maxBioLength: z.number().int().min(0).max(2_000),
  allowComments: z.boolean(),
  allowLikes: z.boolean(),
  allowSharing: z.boolean(),
  allowRegistration: z.boolean(),
  maintenanceMode: z.boolean(),
  /** When a user has no explicit category permission, this decides whether they may post. */
  defaultCategoryPostingAllowed: z.boolean(),
});

export type PlatformSettings = z.infer<typeof full>;

export const DEFAULT_SETTINGS: PlatformSettings = {
  contentChunkThresholdBytes: 768_000,
  maxWorkSizeBytes: 5_000_000,
  maxCommentLength: 2_000,
  maxBioLength: 500,
  allowComments: true,
  allowLikes: true,
  allowSharing: true,
  allowRegistration: true,
  maintenanceMode: false,
  defaultCategoryPostingAllowed: true,
};

export const settingsUpdateSchema = full.partial().strict();

const ref = () => db.doc("platform/settings");

class SettingsService {
  private cache: { value: PlatformSettings; expiresAt: number } | null = null;
  private inflight: Promise<PlatformSettings> | null = null;

  async get(): Promise<PlatformSettings> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    // Collapse concurrent cache misses into one Firestore read.
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<PlatformSettings> {
    const snap = await ref().get();
    const stored = snap.exists ? snap.data() ?? {} : {};
    const merged = full.safeParse({ ...DEFAULT_SETTINGS, ...stored });
    const value = merged.success ? merged.data : DEFAULT_SETTINGS;
    this.cache = { value, expiresAt: Date.now() + env.SETTINGS_CACHE_TTL_MS };
    return value;
  }

  /** Applies a validated partial update and refreshes the cache immediately. */
  async update(
    patch: Partial<PlatformSettings>,
    adminId: string,
  ): Promise<{ before: PlatformSettings; after: PlatformSettings }> {
    const before = await this.get();
    const after = full.parse({ ...before, ...patch });
    await ref().set({ ...patch, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminId }, { merge: true });
    this.cache = { value: after, expiresAt: Date.now() + env.SETTINGS_CACHE_TTL_MS };
    return { before, after };
  }

  invalidate() {
    this.cache = null;
  }

  /** The subset safe to show to anonymous visitors and clients. */
  async getPublic() {
    const s = await this.get();
    return {
      maxCommentLength: s.maxCommentLength,
      maxBioLength: s.maxBioLength,
      allowComments: s.allowComments,
      allowLikes: s.allowLikes,
      allowSharing: s.allowSharing,
      allowRegistration: s.allowRegistration,
      maintenanceMode: s.maintenanceMode,
      maxWorkSizeBytes: s.maxWorkSizeBytes,
    };
  }
}

export const settingsService = new SettingsService();
