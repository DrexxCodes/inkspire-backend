-- Inkspire PostgreSQL schema, part 2: works (posts) and weekly prompts.
--
-- Run AFTER sql/schema.sql (or use `pnpm db:migrate`, which runs every file in sql/ in order).
-- Everything here is idempotent: re-running it is safe.
--
-- What moved from Firestore to PostgreSQL
--   works/{id}                          -> works
--   works/{id}/revisions/{rN}           -> work_revisions
--   works/{id}/revisions/{rN}/chunks/*  -> work_revision_chunks
--   works/{id}/chunks/*                 -> (gone) the current text is the chunks of works.current_revision_id
--   works/{id}/draftState/current       -> work_drafts + work_draft_chunks
--   works/{id}/likes/{uid}              -> work_likes
--   works/{id}/comments/{id}            -> work_comments
--   reviewRequests/{workId_revId}       -> work_review_requests
--   idempotency/{hash}                  -> work_idempotency
-- Users, categories, platform settings, notifications and Firebase Auth stay on Firebase.
-- That is why author_id / user_id / category_id are plain text columns (Firebase ids), not foreign keys.
--
-- How posting works, in the same order Firestore did it, but atomically in ONE transaction:
--   1. insert the work                          (works)
--   2. insert revision r1 and its text chunks   (work_revisions, work_revision_chunks)
--   3. record the idempotency key               (work_idempotency)
--   The "current version" pointer (works.current_revision_id) is a deferred foreign key, so a
--   work can never point at a revision that does not exist. Flipping it is a single UPDATE, so a
--   reader sees either the old complete version or the new complete one, never half of a save.
--   Counters (likes, comments, shares, views) are plain columns updated in the same transaction
--   as the row that causes them. Platform-wide work totals are computed from this table.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Timestamps are kept at millisecond precision so the API can use them as exact keyset cursors
-- (a JavaScript Date cannot carry microseconds, which would otherwise skip or repeat rows).
create or replace function inkspire_now() returns timestamptz
language sql volatile as $$ select date_trunc('milliseconds', clock_timestamp()) $$;

-- 32 hex characters. Matches the API's id format (letters, digits, - and _).
create or replace function inkspire_id() returns text
language sql volatile as $$ select replace(gen_random_uuid()::text, '-', '') $$;

create or replace function inkspire_block_update() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name using errcode = '23000';
end
$$;

-- ---------------------------------------------------------------------------
-- Prompts: a topic, in a category, that writers answer during a window (usually one week)
-- ---------------------------------------------------------------------------
create table if not exists prompts (
  id                    text primary key default inkspire_id(),
  title                 text not null check (char_length(title) between 3 and 140),
  description           text not null default '' check (char_length(description) <= 2000),
  category_id           text not null,
  -- draft: only admins see it. published: everyone sees it. The phase (upcoming, open, judging,
  -- completed) is derived from starts_at, ends_at and winners_announced_at.
  status                text not null default 'draft' check (status in ('draft', 'published')),
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  max_entries_per_user  smallint not null default 1 check (max_entries_per_user between 1 and 10),
  winners_announced_at  timestamptz,
  created_by            text not null,
  created_at            timestamptz not null default inkspire_now(),
  updated_at            timestamptz not null default inkspire_now(),
  published_at          timestamptz,
  constraint prompts_window check (ends_at > starts_at)
);
create index if not exists prompts_public_idx   on prompts (status, starts_at desc, id desc);
create index if not exists prompts_admin_idx    on prompts (created_at desc, id desc);
create index if not exists prompts_category_idx on prompts (category_id);

-- ---------------------------------------------------------------------------
-- Works
-- ---------------------------------------------------------------------------
create table if not exists works (
  id                    text primary key default inkspire_id(),
  author_id             text not null,
  title                 text not null,
  title_lower           text generated always as (lower(title)) stored,
  description           text not null default '',
  excerpt               text not null default '',
  category_id           text not null,
  -- Set when the work was written for a prompt. Shown as a tag on Discover.
  prompt_id             text references prompts (id) on delete restrict,
  cover_image_url       text,
  status                text not null default 'draft'
                          check (status in ('draft', 'published', 'flagged', 'archived', 'deleted')),
  visibility            text not null default 'public' check (visibility in ('public', 'private')),
  moderation_status     text not null default 'clean'
                          check (moderation_status in ('clean', 'flagged', 'underReview', 'approved', 'rejected')),
  moderation            jsonb,
  status_before_flag    text,
  status_before_delete  text,
  chunk_count           integer not null default 0,
  total_bytes           integer not null default 0,
  like_count            integer not null default 0 check (like_count >= 0),
  comment_count         integer not null default 0 check (comment_count >= 0),
  share_count           integer not null default 0 check (share_count >= 0),
  view_count            integer not null default 0 check (view_count >= 0),
  current_revision_id   text not null,
  last_revision_number  integer not null default 0,
  publish_count         integer not null default 0,
  created_at            timestamptz not null default inkspire_now(),
  updated_at            timestamptz not null default inkspire_now(),
  published_at          timestamptz,
  deleted_at            timestamptz,
  deleted_by            text,
  -- Lets prompt_winners prove that a winning work really belongs to that prompt.
  constraint works_id_prompt_key unique (id, prompt_id)
);

-- Discover feed (published + public only), one index per sort, plus the category and title search paths.
create index if not exists works_feed_latest_idx    on works (published_at desc, id desc)  where status = 'published' and visibility = 'public';
create index if not exists works_feed_cat_idx       on works (category_id, published_at desc, id desc) where status = 'published' and visibility = 'public';
create index if not exists works_feed_popular_idx   on works (like_count desc, id desc)    where status = 'published' and visibility = 'public';
create index if not exists works_feed_viewed_idx    on works (view_count desc, id desc)    where status = 'published' and visibility = 'public';
create index if not exists works_feed_discussed_idx on works (comment_count desc, id desc) where status = 'published' and visibility = 'public';
create index if not exists works_feed_title_idx     on works (title_lower text_pattern_ops, id) where status = 'published' and visibility = 'public';
-- Authors: their own list, and their public profile.
create index if not exists works_author_idx         on works (author_id, updated_at desc, id desc);
create index if not exists works_author_status_idx  on works (author_id, status, updated_at desc, id desc);
create index if not exists works_author_public_idx  on works (author_id, published_at desc, id desc) where status = 'published' and visibility = 'public';
-- Admin and moderation lists.
create index if not exists works_admin_idx          on works (updated_at desc, id desc);
create index if not exists works_admin_status_idx   on works (status, updated_at desc, id desc);
create index if not exists works_admin_moderation_idx on works (moderation_status, updated_at desc, id desc);
-- Category counters and "is this category in use".
create index if not exists works_category_idx       on works (category_id);
create index if not exists works_category_published_idx on works (category_id) where status = 'published';
-- Prompt entries.
create index if not exists works_prompt_feed_idx    on works (prompt_id, published_at desc, id desc) where prompt_id is not null and status = 'published' and visibility = 'public';
create index if not exists works_prompt_author_idx  on works (prompt_id, author_id) where prompt_id is not null;

-- ---------------------------------------------------------------------------
-- Revisions: immutable history. Every explicit save appends one.
-- ---------------------------------------------------------------------------
create table if not exists work_revisions (
  work_id                   text not null references works (id) on delete cascade,
  id                        text not null check (id ~ '^r[0-9]{1,9}$'),
  revision_number           integer not null,
  title                     text not null,
  description               text not null default '',
  excerpt                   text not null default '',
  category_id               text not null,
  cover_image_url           text,
  chunk_count               integer not null,
  total_bytes               integer not null,
  created_at                timestamptz not null default inkspire_now(),
  created_by                text not null,
  change_reason             text,
  based_on_revision_id      text,
  restored_from_revision_id text,
  primary key (work_id, id),
  unique (work_id, revision_number)
);

-- The text of a revision, split into chunks so readers can stream a long work a few chunks at a time.
create table if not exists work_revision_chunks (
  work_id     text not null,
  revision_id text not null,
  idx         integer not null check (idx >= 0),
  content     text not null,
  byte_size   integer not null,
  primary key (work_id, revision_id, idx),
  foreign key (work_id, revision_id) references work_revisions (work_id, id) on delete cascade
);

drop trigger if exists work_revisions_immutable on work_revisions;
create trigger work_revisions_immutable before update on work_revisions
  for each row execute function inkspire_block_update();
drop trigger if exists work_revision_chunks_immutable on work_revision_chunks;
create trigger work_revision_chunks_immutable before update on work_revision_chunks
  for each row execute function inkspire_block_update();

-- works.current_revision_id must name one of the work's own revisions. Deferred, so a work and
-- its first revision can be inserted in either order inside one transaction.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'works_current_revision_fk') then
    alter table works
      add constraint works_current_revision_fk
      foreign key (id, current_revision_id) references work_revisions (work_id, id)
      deferrable initially deferred;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Autosave: the writer's current unsaved state. Never part of the revision history.
-- ---------------------------------------------------------------------------
create table if not exists work_drafts (
  work_id              text primary key references works (id) on delete cascade,
  version              bigint not null,
  title                text not null default '',
  description          text not null default '',
  category_id          text not null default '',
  cover_image_url      text,
  chunk_count          integer not null,
  total_bytes          integer not null,
  based_on_revision_id text,
  updated_at           timestamptz not null default inkspire_now()
);

create table if not exists work_draft_chunks (
  work_id   text not null references work_drafts (work_id) on delete cascade,
  idx       integer not null check (idx >= 0),
  content   text not null,
  byte_size integer not null,
  primary key (work_id, idx)
);

-- ---------------------------------------------------------------------------
-- Engagement
-- ---------------------------------------------------------------------------
create table if not exists work_likes (
  work_id    text not null references works (id) on delete cascade,
  user_id    text not null,
  created_at timestamptz not null default inkspire_now(),
  primary key (work_id, user_id)
);

create table if not exists work_comments (
  id                text primary key default inkspire_id(),
  work_id           text not null references works (id) on delete cascade,
  user_id           text not null,
  content           text not null,
  parent_comment_id text references work_comments (id) on delete cascade,
  status            text not null default 'active' check (status in ('active', 'deleted')),
  like_count        integer not null default 0 check (like_count >= 0),
  reply_count       integer not null default 0 check (reply_count >= 0),
  deleted_by        text,
  created_at        timestamptz not null default inkspire_now(),
  updated_at        timestamptz not null default inkspire_now()
);
create index if not exists work_comments_thread_idx on work_comments (work_id, parent_comment_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Moderation review queue (the audit trail stays in moderation_actions)
-- ---------------------------------------------------------------------------
create table if not exists work_review_requests (
  id            text primary key,           -- "{workId}_{revisionId}"
  work_id       text not null references works (id) on delete cascade,
  revision_id   text not null,
  author_id     text not null,
  requested_by  text not null,
  requested_at  timestamptz not null default inkspire_now(),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason        text,
  resolved_by   text,
  resolved_at   timestamptz,
  turnaround_ms bigint
);
create index if not exists work_review_requests_queue_idx on work_review_requests (status, requested_at, id);

-- Makes "create work" safe to retry. A retried request with the same key returns the same work.
-- Old rows can be purged on a schedule, for example:
--   delete from work_idempotency where created_at < now() - interval '7 days';
create table if not exists work_idempotency (
  user_id    text not null,
  idem_key   text not null,
  work_id    text not null references works (id) on delete cascade,
  created_at timestamptz not null default inkspire_now(),
  primary key (user_id, idem_key)
);

-- ---------------------------------------------------------------------------
-- Prompt winners: up to three placements per prompt, chosen by an admin.
-- ---------------------------------------------------------------------------
create table if not exists prompt_winners (
  prompt_id   text not null references prompts (id) on delete cascade,
  work_id     text not null,
  placement   smallint not null check (placement between 1 and 3),
  note        text,
  selected_by text not null,
  selected_at timestamptz not null default inkspire_now(),
  primary key (prompt_id, work_id),
  constraint prompt_winners_placement_key unique (prompt_id, placement),
  -- The work must have been written for this very prompt, and a winning work cannot be moved off it.
  foreign key (work_id, prompt_id) references works (id, prompt_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Server only access, same as the analytics tables: RLS on with no policies, public roles revoked.
-- ---------------------------------------------------------------------------
alter table prompts               enable row level security;
alter table works                 enable row level security;
alter table work_revisions        enable row level security;
alter table work_revision_chunks  enable row level security;
alter table work_drafts           enable row level security;
alter table work_draft_chunks     enable row level security;
alter table work_likes            enable row level security;
alter table work_comments         enable row level security;
alter table work_review_requests  enable row level security;
alter table work_idempotency      enable row level security;
alter table prompt_winners        enable row level security;

revoke all on prompts, works, work_revisions, work_revision_chunks, work_drafts, work_draft_chunks,
              work_likes, work_comments, work_review_requests, work_idempotency, prompt_winners
  from anon, authenticated;
