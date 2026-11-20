import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireToken, requireUserAllowInactive, getAuth } from "../../middleware/authenticate.js";
import { parse } from "../../utils/validation.js";
import { ok } from "../../utils/respond.js";
import { toPrivateProfile } from "../../repositories/users.repo.js";
import { ensureAvatar, isUsernameAvailable, registerProfile, registerSchema } from "./auth.service.js";

export async function authRoutes(app: FastifyInstance) {
  // Public: lets the sign up form check a username before creating the Firebase account.
  app.get("/username-available", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { u } = parse(z.object({ u: z.string().trim().toLowerCase().max(40) }), req.query);
    return ok({ available: await isUsernameAvailable(u) });
  });

  // Called once after the Firebase Auth user exists. Creates the Firestore profile.
  app.post(
    "/register",
    { preHandler: requireToken, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parse(registerSchema, req.body);
      const profile = await registerProfile(req.token!, body, req.log);
      reply.status(201);
      return ok({ profile: toPrivateProfile(profile) });
    },
  );

  // The signed in user's profile and effective permissions. Works for disabled or blocked
  // accounts too, so the client can explain what is going on.
  app.get("/me", { preHandler: requireUserAllowInactive }, async (req) => {
    const auth = getAuth(req);
    const profile = await ensureAvatar(auth.profile, req.log);
    return ok({
      profile: toPrivateProfile(profile),
      accountStatus: profile.accountStatus,
      permissions: auth.permissions,
    });
  });
}
