-- ── KindleHub D1 (SQLite) schema — Cloudflare Workers backend ───────────────
-- The zero-egress replacement for the Supabase REST backend. Pairs with
-- api-worker.js (which holds the RLS/RPC/trigger logic that lived in Postgres).
--
-- You normally DON'T need to run this by hand: api-worker.js auto-creates every
-- table on its first request (ensureSchema). Just deploy the Worker + bind a D1
-- database, then open the app once. Apply manually only if you want to pre-load:
--   wrangler d1 create kindlehub
--   wrangler d1 execute kindlehub --remote --file=schema-d1.sql   (runs the WHOLE file)
-- ⚠ Do NOT paste this into the D1 dashboard "Console" (one statement per Execute)
--   or "Studio"/Explore-Data editor (its Run only executes the statement at the
--   cursor → you get just one table). Use wrangler --file, or the Worker auto-create.
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

-- Turnkey IN-APP moderator invite/grant system (replaces the env-var MOD_HASHES
-- flow). code_hash is the SHA-256 of a randomly-generated plaintext invite code
-- — the plaintext itself never reaches the server, only its hash. Lifecycle:
--   pending   -- admin generated a code, nobody has entered it yet
--   requested -- someone entered the code (kh_mod_claim); awaiting admin review
--   active    -- admin Accepted the request; the code now passes isMod()
--   revoked   -- admin Revoked (or Declined a request) — the code stops working
-- See kh_mod_create / kh_mod_claim / kh_mod_list / kh_mod_approve /
-- kh_mod_decline / kh_mod_revoke in api-worker.js, and isMod()'s DB check.
CREATE TABLE IF NOT EXISTS kh_mod_grants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash      TEXT UNIQUE,
  status         TEXT DEFAULT 'pending',
  requester_name TEXT,
  requester_uid  TEXT,
  created_at     TEXT,
  claimed_at     TEXT,
  approved_at    TEXT
);
CREATE INDEX IF NOT EXISTS kh_mod_grants_status ON kh_mod_grants(status);

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

-- Shared App Store: apps published by any user, downloadable by everyone.
CREATE TABLE IF NOT EXISTS kh_store_apps (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  html       TEXT NOT NULL,
  cat        TEXT DEFAULT 'Fun',
  author     TEXT DEFAULT '',
  model      TEXT DEFAULT '',
  created_at TEXT,
  downloads  INTEGER DEFAULT 0,
  owner_secret TEXT
);
CREATE INDEX IF NOT EXISTS kh_store_apps_rank ON kh_store_apps(downloads DESC, created_at DESC);

-- Auto-maintenance bug queue (daily self-healing cron). One row per distinct bug
-- signature, persisted so a run that hits the Gemini free-quota resumes tomorrow.
-- status: new | fixed | needs_review | wont_fix | deferred | failed
CREATE TABLE IF NOT EXISTS kh_maint (
  sig        TEXT PRIMARY KEY,
  status     TEXT DEFAULT 'new',
  view       TEXT DEFAULT '',
  err        TEXT DEFAULT '',
  fix_kind   TEXT DEFAULT '',
  fix_code   TEXT DEFAULT '',
  detect     TEXT DEFAULT '',
  confirm    TEXT DEFAULT '',
  attempts   INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS kh_maint_status ON kh_maint(status, updated_at);

-- Anonymous research beacon (admin "Research" panel in Feedback). One row per
-- device per day; NO usernames — age is a coarse bracket index into the app's
-- KH_AGE_RANGES, views a small {view:count} JSON of that day's page opens.
CREATE TABLE IF NOT EXISTS kh_research (
  id         TEXT PRIMARY KEY,        -- '<day>_<device8>'
  day        TEXT NOT NULL,
  age        INTEGER DEFAULT -1,      -- KH_AGE_RANGES bracket index, -1 unknown
  tier       TEXT DEFAULT 'g',        -- g guest / p free / u ultra / c creator
  views      TEXT DEFAULT '{}',
  ai_n       INTEGER DEFAULT 0,
  msg_n      INTEGER DEFAULT 0,
  game_n     INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS kh_research_day ON kh_research(day);
