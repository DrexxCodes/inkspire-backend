import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Stable anonymous key for view and share de-duplication. Not stored, only compared. */
export function viewerKey(req: FastifyRequest): string {
  if (req.auth) return `u:${req.auth.uid}`;
  const raw = `${req.ip}|${req.headers["user-agent"] ?? ""}`;
  return `a:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}
