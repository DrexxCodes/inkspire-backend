import type { FastifyInstance } from "fastify";

/**
 * One structured line per request: request id, user id, endpoint, status, duration and error
 * code. Bodies, tokens and headers are never logged.
 */
export function registerRequestLogging(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    req.log.info(
      {
        requestId: req.id,
        userId: req.auth?.uid ?? req.token?.uid,
        method: req.method,
        endpoint: route,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        errorCode: req.errorCode,
      },
      "request completed",
    );
  });
}
