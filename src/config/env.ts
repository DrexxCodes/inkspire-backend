import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().min(1),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  FIREBASE_WEB_API_KEY: z.string().default(""),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.enum(["true", "false"]).default("true"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default("inkspire"),

  SETTINGS_CACHE_TTL_MS: z.coerce.number().int().min(0).default(60_000),
  SUPER_ADMIN_EMAILS: z.string().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Names only. Values are never printed.
  const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(`Invalid environment configuration. Check: ${names}`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  superAdminEmails: new Set(
    parsed.data.SUPER_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  ),
  isProd: parsed.data.NODE_ENV === "production",
};
