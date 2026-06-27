-- ── KindleHub D1 (SQLite) schema — Cloudflare Workers backend ───────────────
-- The zero-egress replacement for the Supabase REST backend. Pairs with
-- api-worker.js (which holds the RLS/RPC/trigger logic that lived in Postgres).
--
-- Apply once:
--   wrangler d1 create kindlehub
--   wrangler d1 execute kindlehub --remote --file=schema-d1.sql
--
-- Type mapping vs the Postgres schema.sql:
--   timestamptz -> TEXT (ISO-8601 strings)   bigserial -> INTEGER PRIMARY KEY AUTOINCREMENT
--   jsonb       -> TEXT (JSON strings)        boolean   -> INTEGER (0/1)
-- The Worker marshals JSON/boolean columns back to real JSON/booleans on read,
-- so the client sees exactly what PostgREST returned. Safe to re-run.

CREATE TABLE IF NOT EXISTS kh_users (
  hash       TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  state      TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS kh_groups (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  creator    TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS kh_messages (
  id            TEXT PRIMARY KEY,
  group_code    TEXT NOT NULL,
  user_id       TEXT DEFAULT '',
  display_name  TEXT DEFAULT '',
  text          TEXT NOT NULL,
  ts            TEXT,
  reply_to      TEXT,
  edited        INTEGER DEFAULT 0,
  important     INTEGER DEFAULT 0,
  pinned        INTEGER DEFAULT 0,
  reactions     TEXT DEFAULT '{}',
  device_hint   TEXT DEFAULT '',
  location_hint TEXT DEFAULT '',
  owner_secret  TEXT
);
CREATE INDEX IF NOT EXISTS kh_messages_group_ts ON kh_messages(group_code, ts);

CREATE TABLE IF NOT EXISTS kh_mail (
  id           TEXT PRIMARY KEY,
  to_user      TEXT NOT NULL,
  from_user    TEXT DEFAULT '',
  from_id      TEXT DEFAULT '',
  subject      TEXT DEFAULT '',
  body         TEXT DEFAULT '',
  ts           TEXT,
  reply_to     TEXT DEFAULT '',
  owner_secret TEXT
);
CREATE INDEX IF NOT EXISTS kh_mail_to_ts   ON kh_mail(to_user, ts);
CREATE INDEX IF NOT EXISTS kh_mail_from_ts ON kh_mail(from_id, ts);

CREATE TABLE IF NOT EXISTS kh_feedback (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  text      TEXT NOT NULL,
  votes     INTEGER DEFAULT 0,
  status    TEXT DEFAULT 'open',
  author    TEXT DEFAULT '',
  comments  TEXT DEFAULT '[]',
  status_at TEXT,
  date      TEXT
);

CREATE TABLE IF NOT EXISTS kh_errors (
  id   TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT DEFAULT 'error',
  date TEXT
);

CREATE TABLE IF NOT EXISTS kh_scores (
  id           TEXT PRIMARY KEY,
  game         TEXT NOT NULL,
  score        INTEGER NOT NULL,
  display_name TEXT DEFAULT '',
  user_id      TEXT DEFAULT '',
  date         TEXT
);
CREATE INDEX IF NOT EXISTS kh_scores_game_score ON kh_scores(game, score DESC);

CREATE TABLE IF NOT EXISTS kh_announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  active     INTEGER DEFAULT 1,
  targets    TEXT DEFAULT '[]',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS kh_presence (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT DEFAULT '',
  last_seen    TEXT
);
CREATE INDEX IF NOT EXISTS kh_presence_last_seen ON kh_presence(last_seen DESC);

CREATE TABLE IF NOT EXISTS kh_shared_api_usage (
  date  TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kh_banned_usernames (
  name       TEXT PRIMARY KEY,
  reason     TEXT DEFAULT '',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS kh_visits (
  device_id TEXT NOT NULL,
  day       TEXT NOT NULL,
  last_seen TEXT,
  ua_hint   TEXT DEFAULT '',
  country   TEXT DEFAULT '',
  city      TEXT DEFAULT '',
  PRIMARY KEY (device_id, day)
);

CREATE TABLE IF NOT EXISTS kh_rate (
  bucket    TEXT PRIMARY KEY,
  win_start TEXT,
  n         INTEGER DEFAULT 0
);
