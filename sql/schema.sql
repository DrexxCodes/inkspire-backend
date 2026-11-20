-- Inkspire PostgreSQL schema (Supabase).
-- PostgreSQL answers: "What does the platform know about its activity?"
-- Only analytics, audit logs and reporting live here. Operational data stays in Firestore.
-- Run this in the Supabase SQL editor, or with psql, before starting the backend.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Analytics rollups (updated as events occur, never rebuilt by scanning Firestore)
-- ---------------------------------------------------------------------------
create table if not exists daily_metrics (
  date            date primary key,
  signups         bigint not null default 0,
  works_created   bigint not null default 0,
  works_published bigint not null default 0,
  likes           bigint not null default 0,
  comments        bigint not null default 0,
  shares          bigint not null default 0,
  views           bigint not null default 0,
  updated_at      timestamptz not null default now()
);

create table if not exists monthly_metrics (
  month           date primary key, -- first day of the month
  signups         bigint not null default 0,
  works_created   bigint not null default 0,
  works_published bigint not null default 0,
  likes           bigint not null default 0,
  comments        bigint not null default 0,
  shares          bigint not null default 0,
  views           bigint not null default 0,
  updated_at      timestamptz not null default now()
);

create table if not exists yearly_metrics (
  year            integer primary key,
  signups         bigint not null default 0,
  works_created   bigint not null default 0,
  works_published bigint not null default 0,
  likes           bigint not null default 0,
  comments        bigint not null default 0,
  shares          bigint not null default 0,
  views           bigint not null default 0,
  updated_at      timestamptz not null default now()
);

-- Idempotency ledger. The primary key makes event processing safe to retry.
-- Old rows can be purged on a schedule, for example:
--   delete from analytics_events where occurred_at < now() - interval '90 days';
create table if not exists analytics_events (
  event_id    text primary key,
  metric      text not null,
  delta       integer not null default 1,
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists analytics_events_occurred_idx on analytics_events (occurred_at);

-- ---------------------------------------------------------------------------
-- Audit logs
-- ---------------------------------------------------------------------------
create table if not exists moderation_actions (
  id           uuid primary key default gen_random_uuid(),
  work_id      text not null,
  user_id      text not null,        -- the work's author
  moderator_id text not null,        -- the acting user
  actor_role   text,
  action       text not null check (action in
                 ('FLAG','UNFLAG','APPROVE','REJECT','DELETE','RESTORE','REQUEST_REVIEW')),
  reason       text,
  revision_id  text,
  created_at   timestamptz not null default now()
);
create index if not exists moderation_actions_work_idx on moderation_actions (work_id, created_at desc);
create index if not exists moderation_actions_user_idx on moderation_actions (user_id, created_at desc);
create index if not exists moderation_actions_created_idx on moderation_actions (created_at desc);
create index if not exists moderation_actions_action_idx on moderation_actions (action, created_at desc);

create table if not exists admin_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  admin_id    text not null,
  action      text not null,
  target_type text not null,
  target_id   text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_logs_created_idx on admin_audit_logs (created_at desc, id desc);
create index if not exists admin_audit_logs_target_idx on admin_audit_logs (target_id, created_at desc);
create index if not exists admin_audit_logs_admin_idx on admin_audit_logs (admin_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Server only access. Row level security is enabled with no policies, and the public
-- Supabase roles are revoked. The backend connects with a privileged server role.
-- ---------------------------------------------------------------------------
alter table daily_metrics       enable row level security;
alter table monthly_metrics     enable row level security;
alter table yearly_metrics      enable row level security;
alter table analytics_events    enable row level security;
alter table moderation_actions  enable row level security;
alter table admin_audit_logs    enable row level security;

revoke all on daily_metrics, monthly_metrics, yearly_metrics, analytics_events,
              moderation_actions, admin_audit_logs from anon, authenticated;
