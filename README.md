# Inkspire backend

Fastify 5, TypeScript (ESM, NodeNext), Firebase Admin, `pg`, Supabase Storage, Zod.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` (development) and fill it in. For production, copy it again to `.env.prod` with the production values (see [Environments](#environments)).

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

3. **PostgreSQL**: run `pnpm db:migrate` (or `pnpm db:migrate:prod`). It applies `sql/schema.sql` and then `sql/002_works_and_prompts.sql`, in order, and is safe to run again. You can also paste both files into the Supabase SQL editor, `schema.sql` first. Together they create the analytics and audit tables, and the **posts** tables (`works`, `work_revisions`, `work_revision_chunks`, `work_drafts`, `work_likes`, `work_comments`, `work_review_requests`, `work_idempotency`) and the **prompts** tables (`prompts`, `prompt_winners`). Row level security is enabled and `anon` and `authenticated` access is revoked. Only the server connection uses these tables.

   Posts live in PostgreSQL. Users, categories, settings, notifications and Firebase Auth stay on Firebase, so a work stores its author and category as plain Firebase ids. Work totals (published count, likes received, platform summary) are counted from PostgreSQL rather than kept as Firestore counters.
4. **Firestore**: log in, deploy the rules and indexes, then verify:
   ```
   firebase login
   pnpm deploy:firestore        # dev:  project from FIREBASE_PROJECT_ID in .env
   pnpm deploy:firestore:prod   # prod: project from FIREBASE_PROJECT_ID in .env.prod (asks you to type the project id)
   pnpm check:firestore         # or check:firestore:prod. Confirms the project matches and every index is ready
   ```
   The deploy project always comes from the env file, never from `.firebaserc`, so it cannot drift from what the server uses.
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
| `pnpm dev` / `pnpm dev:prod` | Watch mode against the dev (`.env`) or prod (`.env.prod`) environment |
| `pnpm build` | Compile to `dist/` |
| `pnpm start` / `pnpm start:prod` | Run the compiled build with `.env` or `.env.prod` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit tests (`node:test` through `tsx`) |
| `pnpm seed` / `pnpm seed:prod` | Seed categories and settings |
| `pnpm make-admin <email> [role]` (`make-admin:prod`) | Give an existing account a role (default `super_admin`) |
| `pnpm check:firestore` (`check:firestore:prod`) | Verify deploy project and that all Firestore indexes exist |
| `pnpm deploy:firestore` (`deploy:firestore:prod`) | Deploy `firestore.rules` and `firestore.indexes.json` to the env's Firebase project |

## Environments

| File | Used by | Purpose |
| --- | --- | --- |
| `.env` | `dev`, `start`, `seed`, `make-admin`, `check:firestore`, `deploy:firestore` | Development |
| `.env.prod` | the same scripts with a `:prod` suffix | Production |

Both files have the same variables (see `.env.example`). Everything except `.env.example` is git ignored.
Set `NODE_ENV=production` in `.env.prod` if you deploy that file. Locally it only turns on `trustProxy`.

**`pnpm dev:prod` runs your local code against the real production Firestore, PostgreSQL and storage.**
Writes are real. On boot the server logs the `firebaseProject` it is using, so check that line before you click around.
The deploy script is separate: `pnpm deploy:firestore:prod` shows the target project and asks you to type its id.
Pass `--yes` (`tsx scripts/deploy-firestore.ts prod --yes`) to skip that prompt in CI.

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
