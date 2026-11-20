import type { FastifyInstance, FastifyError } from "fastify";
import { AppError } from "../utils/errors.js";

interface Shape {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function toShape(err: FastifyError & { code?: string; statusCode?: number }): Shape {
  if (err instanceof AppError) {
    return { status: err.statusCode, code: err.code, message: err.message, details: err.details };
  }
  if (err.statusCode === 429 || err.code === "RATE_LIMITED") {
    return { status: 429, code: "RATE_LIMITED", message: err.message || "Too many requests." };
  }
  if (err.code === "FST_REQ_FILE_TOO_LARGE") {
    return { status: 413, code: "FILE_TOO_LARGE", message: "That file is too large (5 MB maximum)." };
  }
  if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "The request body is too large." };
  }
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return { status: err.statusCode, code: "BAD_REQUEST", message: "The request could not be processed." };
  }
  // Anything else is a bug or infrastructure failure. Nothing internal is returned.
  return { status: 500, code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." };
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    const e = err as FastifyError;
    const shape = toShape(e);
    req.errorCode = shape.code;
    if (shape.status >= 500) {
      // Full detail stays in server logs only. Auth headers are redacted by the logger config.
      req.log.error({ err: { message: e.message, stack: e.stack, code: e.code } }, "request failed");
      // Firestore code 9 = FAILED_PRECONDITION. For queries this means a composite index is missing
      // (or still building). The message carries a console link that creates it in one click.
      const message = String(e.message ?? "");
      if ((e.code as unknown) === 9 && /index/i.test(message)) {
        const link = message.match(/https:\/\/console\.firebase\.google\.com\S+/)?.[0];
        req.log.error({ createIndexUrl: link }, "FIRESTORE_INDEX_MISSING. Run `pnpm check:firestore`, then `pnpm deploy:firestore`");
      }
    }
    reply.status(shape.status).send({
      success: false,
      error: {
        code: shape.code,
        message: shape.message,
        ...(shape.details ? { details: shape.details } : {}),
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    req.errorCode = "ROUTE_NOT_FOUND";
    reply.status(404).send({
      success: false,
      error: { code: "ROUTE_NOT_FOUND", message: "That route does not exist." },
    });
  });
}
