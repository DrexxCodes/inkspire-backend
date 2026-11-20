import type { FastifyRequest } from "fastify";
import type { PermissionKey } from "../config/permissions.js";
import { forbidden, unauthorized } from "../utils/errors.js";
import { settingsService, type PlatformSettings } from "../services/settings.service.js";

/** Route guard: the caller must hold every listed permission. Evaluated from server state only. */
export function requirePermission(...keys: PermissionKey[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth) throw unauthorized();
    for (const key of keys) {
      if (!req.auth.permissions[key]) {
        throw forbidden("INSUFFICIENT_PERMISSIONS", "You do not have permission to perform this action.");
      }
    }
  };
}

type FeatureFlag = "allowComments" | "allowLikes" | "allowSharing";

const FEATURE_MESSAGES: Record<FeatureFlag, string> = {
  allowComments: "Commenting is currently turned off.",
  allowLikes: "Liking is currently turned off.",
  allowSharing: "Sharing is currently turned off.",
};

export function requireFeature(flag: FeatureFlag & keyof PlatformSettings) {
  return async (): Promise<void> => {
    const settings = await settingsService.get();
    if (!settings[flag]) throw forbidden("FEATURE_DISABLED", FEATURE_MESSAGES[flag]);
  };
}
