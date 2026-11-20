import type { FastifyRequest } from "fastify";
import type { DecodedIdToken } from "firebase-admin/auth";
import { adminAuth } from "../config/firebase.js";
import { hasAnyPermission, resolvePermissions } from "../config/permissions.js";
import type { AuthContext } from "../types/domain.js";
import { forbidden, unauthorized, unavailable } from "../utils/errors.js";
import { getCachedProfile } from "../services/profile-cache.service.js";
import { settingsService } from "../services/settings.service.js";

declare module "fastify" {
  interface FastifyRequest {
    token?: DecodedIdToken;
    auth?: AuthContext;
    errorCode?: string;
  }
}

async function verifyBearer(req: FastifyRequest): Promise<DecodedIdToken> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  try {
    return await adminAuth.verifyIdToken(header.slice(7));
  } catch {
    throw unauthorized("INVALID_TOKEN", "Your session is invalid or has expired. Please sign in again.");
  }
}

async function buildContext(token: DecodedIdToken, opts: { allowInactive: boolean }): Promise<AuthContext> {
  const profile = await getCachedProfile(token.uid);
  if (!profile) throw forbidden("PROFILE_REQUIRED", "Finish setting up your profile to continue.");

  // Account state is enforced here, server side, on every request.
  if (!opts.allowInactive) {
    if (profile.accountStatus === "blocked") throw forbidden("ACCOUNT_BLOCKED", "This account has been blocked.");
    if (profile.accountStatus === "disabled") throw forbidden("ACCOUNT_DISABLED", "This account is currently disabled.");
  }

  return {
    uid: token.uid,
    email: token.email ?? null,
    emailVerified: token.email_verified === true,
    profile,
    permissions: resolvePermissions(profile.role, profile.permissions),
  };
}

/** Only verifies the Firebase ID token. Used where no profile exists yet (registration). */
export async function requireToken(req: FastifyRequest): Promise<void> {
  req.token = await verifyBearer(req);
}

/** Authenticates, loads the profile, enforces account status and maintenance mode. */
export async function requireUser(req: FastifyRequest): Promise<void> {
  const token = await verifyBearer(req);
  req.token = token;
  const auth = await buildContext(token, { allowInactive: false });
  const settings = await settingsService.get();
  if (settings.maintenanceMode && !hasAnyPermission(auth.permissions)) {
    throw unavailable("MAINTENANCE_MODE", "Inkspire is undergoing maintenance. Please try again soon.");
  }
  req.auth = auth;
}

/** Like requireUser, but lets disabled or blocked users through so they can see their status. */
export async function requireUserAllowInactive(req: FastifyRequest): Promise<void> {
  const token = await verifyBearer(req);
  req.token = token;
  req.auth = await buildContext(token, { allowInactive: true });
}

/** Public routes that behave differently for signed in users. Bad tokens are treated as anonymous. */
export async function optionalUser(req: FastifyRequest): Promise<void> {
  if (!req.headers.authorization) return;
  try {
    const token = await verifyBearer(req);
    req.token = token;
    req.auth = await buildContext(token, { allowInactive: false });
  } catch {
    req.auth = undefined;
  }
}

export function getAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
