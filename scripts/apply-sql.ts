/**
 * Applies the SQL files in sql/ in order (schema.sql, then 002_..., 003_...). Every file is
 * idempotent (create ... if not exists), so running this again is safe.
 *
 *   pnpm db:migrate        uses .env
 *   pnpm db:migrate:prod   uses .env.prod
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const dir = join(import.meta.dirname, "..", "sql");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort((a, b) => (a === "schema.sql" ? -1 : b === "schema.sql" ? 1 : a.localeCompare(b)));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const client = new pg.Client({
  connectionString: url,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

await client.connect();
try {
  for (const f of files) {
    process.stdout.write(`applying ${f} ... `);
    await client.query(readFileSync(join(dir, f), "utf8"));
    console.log("ok");
  }
} finally {
  await client.end();
}
