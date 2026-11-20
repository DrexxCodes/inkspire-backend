# Inkspire backend

Fastify 5, TypeScript (ESM, NodeNext), Firebase Admin, `pg`, Supabase Storage, Zod.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in.

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` | Server basics |
| `CORS_ORIGINS` | Comma separated list of allowed web origins |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Service account for Firebase Admin. Keep the quotes and `\n` escapes in the key |
| `FIREBASE_WEB_API_KEY` | Used server side to ask Firebase to send password reset emails |
| `DATABASE_URL`, `DATABASE_SSL` | Supabase PostgreSQL connection (pooled string) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Object storage. The service role key never leaves the server |
| `SETTINGS_CACHE_TTL_MS` | How long platform settings are cached |
| `SUPER_ADMIN_EMAILS` | Verified emails that become `super_admin` when they register |

3. **PostgreSQL**: run `sql/schema.sql` in the Supabase SQL editor. It creates `daily_metrics`, `monthly_metrics`, `yearly_metrics`, `analytics_events`, `moderation_actions` and `admin_audit_logs`, enables row level security and revokes `anon` and `authenticated` access. Only the server connection uses these tables.
4. **Firestore**: set the project, deploy the rules and indexes, then verify:
   ```
   firebase login
   firebase use <your-firebase-project-id>   # must equal FIREBASE_PROJECT_ID in .env
   pnpm deploy:firestore                      # firebase deploy --only firestore:rules,firestore:indexes
   pnpm check:firestore                       # confirms the project matches and every index is ready
   ```
   `firestore.rules` denies all client access (only the backend, via the Admin SDK, touches Firestore).
   Indexes take a few minutes to build; `check:firestore` shows which are still building.
5. **Storage**: create the bucket named in `SUPABASE_STORAGE_BUCKET` and make it public for reads (uploads happen only through the API).
6. Optional seed data (categories, default platform settings): `pnpm seed`
7. **First admin**: sign up on the site, then run `pnpm make-admin you@example.com` (makes you `super_admin`).
   Use `pnpm make-admin someone@example.com admin` for other roles. Alternatively set `SUPER_ADMIN_EMAILS`, but that only
   applies at registration and only if the email is verified, which the web app does not currently do for password sign ups.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch mode with `.env` loaded |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (`node:test` through `tsx`) |
| `npm run seed` | Seed categories and settings |
| `pnpm make-admin <email> [role]` | Give an existing account a role (default `super_admin`) |
| `pnpm check:firestore` | Verify deploy project and that all Firestore indexes exist |
| `pnpm deploy:firestore` | Deploy `firestore.rules` and `firestore.indexes.json` |

## Layout

```
src/
  config/        env, firebase, postgres, supabase, role permissions
  middleware/    authenticate (token, profile, status, maintenance), authorize
  plugins/       security headers, CORS, rate limit, error handler, request logging
  repositories/  Firestore reads and writes (users, categories, works)
  services/      chunking, content, settings, stats, audit, analytics, views, avatars, storage, notifications
  modules/       one folder per feature: routes + service (+ pure rules where they exist)
                 auth, users, categories, settings, notifications, works, revisions,
                 likes, comments, shares, moderation, analytics, admin
  utils/         errors, validation, pagination, text, time, serialize, retry, respond
test/            unit tests for the pure logic
```

## API conventions

- Base path `/api/v1`. Success: `{ "success": true, "data": ... }`. Failure: `{ "success": false, "error": { "code", "message", "details?" } }`.
- Lists use opaque cursors and return `{ items, nextCursor }`. Every list endpoint is paginated.
- Writes that can be retried safely accept an idempotency key (work creation, likes, review requests, analytics events).
- Roles: `user`, `moderator`, `admin`, `super_admin`. Per user permission overrides are stored on the user. Nobody can act on themselves, and only a super admin can act on an equal or higher rank.

## How content is stored

`works/{id}/chunks/{revisionId}_{000000}` holds the text. A save writes all chunks first, then flips `currentRevisionId` in one transaction, so readers never see a half written revision. Old chunks of replaced drafts are cleaned up with a minimum age guard so an in flight save is never deleted.

## Analytics

Events go into an idempotent `analytics_events` ledger and the daily, monthly and yearly rollups update in one transaction. Views are buffered in memory (30 minute dedupe per viewer and work) and flushed every 10 seconds. Shares are de-duplicated and only the aggregate counter is kept.
