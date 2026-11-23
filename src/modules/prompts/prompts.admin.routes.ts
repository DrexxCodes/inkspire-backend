import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAuth, requireUser } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/authorize.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { listPublicWorks } from "../works/works.service.js";
import { adminPromptListQuery, createPromptSchema, entriesQuery, updatePromptSchema, winnersSchema } from "./prompts.schemas.js";
import {
  createPrompt,
  deletePrompt,
  getPromptDto,
  listAdminPrompts,
  publishPrompt,
  setWinners,
  unpublishPrompt,
  updatePrompt,
} from "./prompts.service.js";

const idParams = z.object({ id: idParam });
const guard = [requireUser, requirePermission("managePrompts")];
const write = { rateLimit: { max: 30, timeWindow: "1 minute" } };

/** Admin and super admin only: the managePrompts permission can never be held by a lower role. */
export async function promptAdminRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: guard, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const q = parse(adminPromptListQuery, req.query);
    const page = await listAdminPrompts(q, getAuth(req));
    return okPage(page.items, page.nextCursor);
  });

  app.get("/:id", { preHandler: guard }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ prompt: await getPromptDto(id, getAuth(req), true) });
  });

  app.post("/", { preHandler: guard, config: write }, async (req, reply) => {
    const prompt = await createPrompt(getAuth(req), parse(createPromptSchema, req.body), req.log);
    reply.status(201);
    return ok({ prompt });
  });

  app.patch("/:id", { preHandler: guard, config: write }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ prompt: await updatePrompt(getAuth(req), id, parse(updatePromptSchema, req.body), req.log) });
  });

  app.post("/:id/publish", { preHandler: guard, config: write }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ prompt: await publishPrompt(getAuth(req), id, req.log) });
  });

  app.post("/:id/unpublish", { preHandler: guard, config: write }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ prompt: await unpublishPrompt(getAuth(req), id, req.log) });
  });

  app.delete("/:id", { preHandler: guard, config: write }, async (req) => {
    const { id } = parse(idParams, req.params);
    await deletePrompt(getAuth(req), id, req.log);
    return ok({ deleted: true });
  });

  // Entries to judge: the published, public works written for this prompt.
  app.get("/:id/entries", { preHandler: guard, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(entriesQuery, req.query);
    await getPromptDto(id, getAuth(req), true);
    const page = await listPublicWorks({ ...q, prompt: id }, getAuth(req));
    return okPage(page.items, page.nextCursor);
  });

  app.put("/:id/winners", { preHandler: guard, config: write }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ prompt: await setWinners(getAuth(req), id, parse(winnersSchema, req.body), req.log) });
  });
}
