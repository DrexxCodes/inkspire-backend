import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { optionalUser } from "../../middleware/authenticate.js";
import { ok, okPage } from "../../utils/respond.js";
import { idParam, parse } from "../../utils/validation.js";
import { listPublicWorks } from "../works/works.service.js";
import { entriesQuery, promptListQuery } from "./prompts.schemas.js";
import { getBillboard, getPromptDto, listPublicPrompts } from "./prompts.service.js";

const idParams = z.object({ id: idParam });
const readLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

/** Public prompt endpoints. Drafts are invisible here. */
export async function promptRoutes(app: FastifyInstance) {
  // Everything the billboard page needs in one request.
  app.get("/billboard", { preHandler: optionalUser, config: readLimit }, async (req) => ok(await getBillboard(req.auth)));

  app.get("/", { preHandler: optionalUser, config: readLimit }, async (req) => {
    const q = parse(promptListQuery, req.query);
    const page = await listPublicPrompts(q, req.auth);
    return okPage(page.items, page.nextCursor);
  });

  app.get("/:id", { preHandler: optionalUser, config: readLimit }, async (req) => {
    const { id } = parse(idParams, req.params);
    return ok({ prompt: await getPromptDto(id, req.auth) });
  });

  // All published entries written for the prompt.
  app.get("/:id/entries", { preHandler: optionalUser, config: readLimit }, async (req) => {
    const { id } = parse(idParams, req.params);
    const q = parse(entriesQuery, req.query);
    await getPromptDto(id, req.auth); // 404 for drafts
    const page = await listPublicWorks({ ...q, prompt: id }, req.auth);
    return okPage(page.items, page.nextCursor);
  });
}
