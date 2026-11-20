import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./config/postgres.js";

const app = await buildApp();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close(); // flushes buffered view counts
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  // Makes it obvious which environment a local server is pointed at. Never log secrets here.
  app.log.info(
    { nodeEnv: env.NODE_ENV, firebaseProject: env.FIREBASE_PROJECT_ID, supabaseUrl: env.SUPABASE_URL },
    "environment",
  );
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
