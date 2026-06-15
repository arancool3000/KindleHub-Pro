-- ── KindleHub schema v4 — complete, ordered, idempotent ────────────────
-- Paste this WHOLE block into Supabase SQL Editor → RUN. Safe to re-run any
-- number of times: it drops functions first (so return-type changes never
-- collide), never drops tables, and re-creates everything else in order.
-- After it runs, wait ~30s for PostgREST to reload (the final NOTIFY does
-- this automatically), then re-run Admin → Diagnostics.

-- ══════════════════════════════════════════════════════════════════════
-- 0. RESET FUNCTIONS FIRST  ← this is what fixes the 42P13 error
--    `create or replace function` cannot change a function's return type,
--    so we drop every (non-trigger, non-policy) function up front. Dropping
--    a function never deletes data. kh_request_secret is intentionally NOT
--    dropped here — RLS policies depend on it, and its return type never
--    changes, so `create or replace` handles it safely below.
-- ══════════════════════════════════════════════════════════════════════
drop function if exists kh_check_rate(text,int,int);
drop function if exists kh_set_reaction(text,text,text);
drop function if exists kh_increment_shared_api(date);
drop function if exists kh_increment_shared_api(text);
drop function if exists kh_increment_shared_api(text,date);
drop function if exists kh_is_admin(text);
drop function if exists kh_post_announcement(text,text,jsonb);
drop function if exists kh_clear_announcements(text);
drop function if exists kh_delete_announcement(bigint,text);
drop function if exists kh_ban_username(text,text);
drop function if exists kh_unban_username(text,text);

create extension if not exists pgcrypto;

-- ══════════════════════════════════════════════════════════════════════
-- 1. TABLES
-- ══════════════════════════════════════════════════════════════════════
create table if not exists kh_users (
  hash       text primary key,
  email      text not null,
  state      text,                                  -- AES-GCM ciphertext
  updated_at timestamptz default now()
);

create table if not exists kh_groups (
  code       text primary key,
  name       text not null,
  creator    text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists kh_messages (
  id           text primary key,
  group_code   text not null,
  user_id      text default '',
  display_name text default '',
  text         text not null,                       -- AES-GCM ciphertext
  ts           timestamptz default now(),
  reply_to     text,
  edited       boolean default false,
  important    boolean default false,
  pinned       boolean default false,
  reactions    jsonb default '{}'::jsonb,
  device_hint  text default '',
  location_hint text default '',
  owner_secret text
);
alter table kh_messages add column if not exists reply_to      text;
alter table kh_messages add column if not exists edited        boolean default false;
alter table kh_messages add column if not exists important     boolean default false;
alter table kh_messages add column if not exists pinned        boolean default false;
alter table kh_messages add column if not exists reactions     jsonb default '{}'::jsonb;
alter table kh_messages add column if not exists device_hint   text default '';
alter table kh_messages add column if not exists location_hint text default '';
alter table kh_messages add column if not exists owner_secret  text;
create index if not exists kh_messages_group_ts on kh_messages(group_code, ts);

-- v8.2: KindleHub Mail — username@kindlehub.pro mail between accounts.
-- subject/body are AES-GCM blobs keyed off the recipient username (same
-- scheme as kh_messages). Read/archive/trash state lives in each user's
-- synced state, NOT here — rows are immutable except sender-unsend.
create table if not exists kh_mail (
  id           text primary key,
  to_user      text not null,
  from_user    text default '',
  from_id      text default '',
  subject      text default '',
  body         text default '',
  ts           timestamptz default now(),
  reply_to     text default '',
  owner_secret text
);
create index if not exists kh_mail_to_ts   on kh_mail(to_user, ts);
create index if not exists kh_mail_from_ts on kh_mail(from_id, ts);
alter table kh_mail enable row level security;
drop policy if exists "kh_mail_read"   on kh_mail;
drop policy if exists "kh_mail_insert" on kh_mail;
drop policy if exists "kh_mail_delete" on kh_mail;
create policy "kh_mail_read"   on kh_mail for select using (true);
create policy "kh_mail_insert" on kh_mail for insert with check (true);
create policy "kh_mail_delete" on kh_mail for delete
  using (owner_secret is not null and owner_secret = kh_request_secret());

create table if not exists kh_feedback (
  id       text primary key,
  type     text not null,
  text     text not null,
  votes    int  default 0,
  status   text default 'open',
  author   text default '',
  comments jsonb default '[]'::jsonb,
  date     timestamptz default now()
);
alter table kh_feedback add column if not exists status   text  default 'open';
alter table kh_feedback add column if not exists author   text  default '';
alter table kh_feedback add column if not exists comments jsonb default '[]'::jsonb;

create table if not exists kh_errors (
  id   text primary key,
  text text not null,
  kind text default 'error',
  date timestamptz default now()
);
alter table kh_errors add column if not exists kind text default 'error';

create table if not exists kh_scores (
  id           text primary key,
  game         text not null,
  score        int  not null,
  display_name text default '',
  user_id      text default '',
  date         timestamptz default now()
);
create index if not exists kh_scores_game_score on kh_scores(game, score desc);

create table if not exists kh_announcements (
  id         bigserial primary key,
  text       text not null,
  active     boolean default true,
  targets    jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
-- Repair tables created by older bootstraps where id had NO default:
-- inserts then failed with 23502 "null value in column id". Safe to re-run.
create sequence if not exists kh_announcements_id_seq;
alter table kh_announcements alter column id set default nextval('kh_announcements_id_seq');
select setval('kh_announcements_id_seq', coalesce((select max(id) from kh_announcements),0)+1, false);

create table if not exists kh_presence (
  user_id      text primary key,
  display_name text default '',
  last_seen    timestamptz default now()
);
create index if not exists kh_presence_last_seen on kh_presence(last_seen desc);

create table if not exists kh_shared_api_usage (
  date  date primary key,
  count int default 0
);

-- Username ban list (approved username reports). Stored lowercased.
create table if not exists kh_banned_usernames (
  name       text primary key,
  reason     text default '',
  created_at timestamptz default now()
);

-- Rate-limit bucket table (hidden from anon; touched only by the function)
create table if not exists kh_rate (
  bucket    text primary key,
  win_start timestamptz not null default now(),
  n         int         not null default 0
);

-- ══════════════════════════════════════════════════════════════════════
-- 2. CHECK CONSTRAINTS — size and format guards
-- ══════════════════════════════════════════════════════════════════════
alter table kh_users    drop constraint if exists kh_users_state_len;
alter table kh_users    add  constraint kh_users_state_len   check (state is null or length(state) <= 16000000);
alter table kh_feedback drop constraint if exists kh_feedback_votes_chk;
alter table kh_feedback add  constraint kh_feedback_votes_chk check (votes between -100000 and 100000);

do $body$ begin
  if not exists(select 1 from pg_constraint where conname='kh_users_hash_format')   then alter table kh_users    add constraint kh_users_hash_format    check (hash ~ '^[0-9a-f]{64}$'); end if;
  if not exists(select 1 from pg_constraint where conname='kh_users_email_len')     then alter table kh_users    add constraint kh_users_email_len      check (length(email) between 3 and 200); end if;
  if not exists(select 1 from pg_constraint where conname='kh_groups_code_format')  then alter table kh_groups   add constraint kh_groups_code_format   check (code ~ '^[0-9]{12}$'); end if;
  if not exists(select 1 from pg_constraint where conname='kh_groups_name_len')     then alter table kh_groups   add constraint kh_groups_name_len      check (length(name) between 1 and 80); end if;
  if not exists(select 1 from pg_constraint where conname='kh_groups_creator_len')  then alter table kh_groups   add constraint kh_groups_creator_len   check (length(coalesce(creator,'')) <= 60); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_text_len')   then alter table kh_messages add constraint kh_messages_text_len    check (length(text) between 1 and 12000); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_name_len')   then alter table kh_messages add constraint kh_messages_name_len    check (length(coalesce(display_name,'')) <= 60); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_uid_len')    then alter table kh_messages add constraint kh_messages_uid_len     check (length(coalesce(user_id,'')) <= 100); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_secret_chk') then alter table kh_messages add constraint kh_messages_secret_chk  check (owner_secret is not null and length(owner_secret) between 16 and 200); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_code_chk')   then alter table kh_messages add constraint kh_messages_code_chk    check (group_code ~ '^[0-9]{12}$'); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_dev_len')    then alter table kh_messages add constraint kh_messages_dev_len     check (length(coalesce(device_hint,'')) <= 80); end if;
  if not exists(select 1 from pg_constraint where conname='kh_messages_loc_len')    then alter table kh_messages add constraint kh_messages_loc_len     check (length(coalesce(location_hint,'')) <= 120); end if;
  if not exists(select 1 from pg_constraint where conname='kh_feedback_type_chk')   then alter table kh_feedback add constraint kh_feedback_type_chk    check (type in ('bug','suggestion')); end if;
  if not exists(select 1 from pg_constraint where conname='kh_feedback_text_len')   then alter table kh_feedback add constraint kh_feedback_text_len    check (length(text) between 3 and 2000); end if;
  if not exists(select 1 from pg_constraint where conname='kh_errors_text_len')     then alter table kh_errors   add constraint kh_errors_text_len      check (length(text) <= 5000); end if;
  if not exists(select 1 from pg_constraint where conname='kh_ann_text_len')        then alter table kh_announcements add constraint kh_ann_text_len    check (length(text) between 1 and 1000); end if;
  if not exists(select 1 from pg_constraint where conname='kh_presence_name_len')   then alter table kh_presence add constraint kh_presence_name_len    check (length(coalesce(display_name,'')) <= 60); end if;
  if not exists(select 1 from pg_constraint where conname='kh_banned_name_len')     then alter table kh_banned_usernames add constraint kh_banned_name_len check (length(name) between 1 and 80); end if;
end $body$;

-- ══════════════════════════════════════════════════════════════════════
-- 3. RLS — enable on every table, wipe old policies, recreate
-- ══════════════════════════════════════════════════════════════════════
alter table kh_users            enable row level security;
alter table kh_groups           enable row level security;
alter table kh_messages         enable row level security;
alter table kh_feedback         enable row level security;
alter table kh_errors           enable row level security;
alter table kh_scores           enable row level security;
alter table kh_announcements    enable row level security;
alter table kh_presence         enable row level security;
alter table kh_shared_api_usage enable row level security;
alter table kh_banned_usernames enable row level security;
alter table kh_rate             enable row level security;

do $body$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname='public'
      and tablename in (
        'kh_users','kh_groups','kh_messages','kh_feedback','kh_errors',
        'kh_scores','kh_announcements','kh_presence','kh_shared_api_usage',
        'kh_banned_usernames','kh_rate'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $body$;

-- Helper used inside the message RLS policies (must exist before they do).
-- Return type (text) never changes, so create-or-replace is safe.
create or replace function kh_request_secret() returns text
language sql stable as $$
  select coalesce(
    (current_setting('request.headers', true)::json->>'x-kh-secret'),
    ''
  );
$$;

create policy "kh_users_read"   on kh_users          for select using (true);
create policy "kh_users_insert" on kh_users          for insert with check (true);
create policy "kh_users_update" on kh_users          for update using (true) with check (true);

create policy "kh_groups_read"   on kh_groups        for select using (true);
create policy "kh_groups_insert" on kh_groups        for insert with check (true);
create policy "kh_groups_update" on kh_groups        for update using (true) with check (true);

create policy "kh_messages_read"   on kh_messages    for select using (true);
create policy "kh_messages_insert" on kh_messages    for insert with check (true);
create policy "kh_messages_update" on kh_messages    for update
  using       (owner_secret is not null and owner_secret = kh_request_secret())
  with check  (owner_secret is not null and owner_secret = kh_request_secret());
create policy "kh_messages_delete" on kh_messages    for delete
  using       (owner_secret is not null and owner_secret = kh_request_secret());

create policy "kh_feedback_read"   on kh_feedback    for select using (true);
create policy "kh_feedback_insert" on kh_feedback    for insert with check (true);
create policy "kh_feedback_update" on kh_feedback    for update using (true) with check (true);

create policy "kh_errors_insert"   on kh_errors      for insert with check (true);

create policy "kh_scores_read"     on kh_scores      for select using (true);
create policy "kh_scores_insert"   on kh_scores      for insert with check (true);

create policy "kh_ann_read"        on kh_announcements for select using (true);

create policy "kh_presence_read"   on kh_presence    for select using (true);
create policy "kh_presence_insert" on kh_presence    for insert with check (true);
create policy "kh_presence_update" on kh_presence    for update using (true) with check (true);

create policy "kh_shared_api_read" on kh_shared_api_usage for select using (true);

create policy "kh_banned_read"     on kh_banned_usernames for select using (true);

-- kh_rate has NO policies on purpose — only kh_check_rate (SECURITY DEFINER)
-- may touch it.

-- ══════════════════════════════════════════════════════════════════════
-- 4. RPC FUNCTIONS  (already dropped in section 0)
-- ══════════════════════════════════════════════════════════════════════

create or replace function kh_check_rate(p_bucket text, p_max int, p_window_secs int)
  returns boolean language plpgsql security definer set search_path = public
as $body$
declare cur int; age interval;
begin
  select n, now() - win_start into cur, age from kh_rate where bucket = p_bucket for update;
  if not found then
    insert into kh_rate(bucket, win_start, n) values (p_bucket, now(), 1)
      on conflict (bucket) do update set n = kh_rate.n + 1;
    return true;
  end if;
  if age > make_interval(secs => p_window_secs) then
    update kh_rate set win_start = now(), n = 1 where bucket = p_bucket;
    return true;
  end if;
  if cur >= p_max then return false; end if;
  update kh_rate set n = n + 1 where bucket = p_bucket;
  return true;
end;
$body$;
revoke all on function kh_check_rate(text,int,int) from public;
grant  execute on function kh_check_rate(text,int,int) to anon, authenticated;

create or replace function kh_set_reaction(p_msg_id text, p_key text, p_user_id text)
  returns void language plpgsql security definer
as $body$
declare cur jsonb; list jsonb; has_uid boolean;
begin
  if length(coalesce(p_key,'')) < 1 or length(coalesce(p_key,'')) > 20 then
    raise exception 'invalid reaction key';
  end if;
  if length(coalesce(p_user_id,'')) < 1 or length(coalesce(p_user_id,'')) > 100 then
    raise exception 'invalid user id';
  end if;
  select coalesce(reactions,'{}'::jsonb) into cur from kh_messages where id = p_msg_id;
  if cur is null then return; end if;
  list := coalesce(cur->p_key,'[]'::jsonb);
  has_uid := list ? p_user_id;
  if has_uid then
    list := coalesce((select jsonb_agg(v) from jsonb_array_elements_text(list) v where v <> p_user_id), '[]'::jsonb);
  else
    list := list || to_jsonb(p_user_id);
  end if;
  if jsonb_array_length(list) = 0 then
    cur := cur - p_key;
  else
    cur := cur || jsonb_build_object(p_key, list);
  end if;
  update kh_messages set reactions = cur where id = p_msg_id;
end;
$body$;
grant execute on function kh_set_reaction(text,text,text) to anon, authenticated;

create or replace function kh_increment_shared_api(p_date date)
  returns int language plpgsql security definer
as $body$
declare new_count int;
begin
  insert into kh_shared_api_usage (date, count) values (p_date, 1)
    on conflict (date) do update set count = kh_shared_api_usage.count + 1
  returning count into new_count;
  return new_count;
end;
$body$;
grant execute on function kh_increment_shared_api(date) to anon, authenticated;

-- Admin token gate. The hash MUST match what the client embeds in
-- _ADMIN_HASHES. Created BEFORE the functions that call it.
create or replace function kh_is_admin(p_token text) returns boolean
  language sql stable as $$
  select encode(digest(coalesce(p_token,''), 'sha256'), 'hex') = any (array[
    'ee99b2d35c0b10d4ef4ff70fba40ba621c17d12fbfd6c61c82e8dc05721f869c'
  ]);
$$;
grant execute on function kh_is_admin(text) to anon, authenticated;

create or replace function kh_post_announcement(p_text text, p_token text, p_targets jsonb)
  returns bigint language plpgsql security definer
as $body$
declare new_id bigint;
begin
  if not kh_is_admin(p_token) then raise exception 'unauthorized'; end if;
  if length(coalesce(p_text,'')) < 1 then raise exception 'empty text'; end if;
  insert into kh_announcements(text, active, targets)
    values (p_text, true, coalesce(p_targets,'[]'::jsonb))
  returning id into new_id;
  return new_id;
end;
$body$;
grant execute on function kh_post_announcement(text,text,jsonb) to anon, authenticated;

create or replace function kh_clear_announcements(p_token text)
  returns int language plpgsql security definer
as $body$
declare n int;
begin
  if not kh_is_admin(p_token) then raise exception 'unauthorized'; end if;
  update kh_announcements set active = false where active = true;
  get diagnostics n = row_count;
  return n;
end;
$body$;
grant execute on function kh_clear_announcements(text) to anon, authenticated;

-- Delete ONE announcement by id (incl. user-targeted ones). Admin-gated,
-- same token as the other announcement RPCs.
create or replace function kh_delete_announcement(p_id bigint, p_token text)
  returns int language plpgsql security definer
as $body$
declare n int;
begin
  if not kh_is_admin(p_token) then raise exception 'unauthorized'; end if;
  delete from kh_announcements where id = p_id;
  get diagnostics n = row_count;
  return n;
end;
$body$;
grant execute on function kh_delete_announcement(bigint,text) to anon, authenticated;

create or replace function kh_ban_username(p_name text, p_token text)
  returns void language plpgsql security definer
as $body$
begin
  if not kh_is_admin(p_token) then raise exception 'not authorized'; end if;
  insert into kh_banned_usernames(name, reason)
    values (lower(trim(p_name)), 'admin')
    on conflict (name) do nothing;
end;
$body$;
grant execute on function kh_ban_username(text,text) to anon, authenticated;

create or replace function kh_unban_username(p_name text, p_token text)
  returns void language plpgsql security definer
as $body$
begin
  if not kh_is_admin(p_token) then raise exception 'not authorized'; end if;
  delete from kh_banned_usernames where name = lower(trim(p_name));
end;
$body$;
grant execute on function kh_unban_username(text,text) to anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 5. TRIGGERS — rate limit + 50-message cap per group
--    (trigger functions always return `trigger`, so no return-type clash;
--     create-or-replace is safe without an explicit drop.)
-- ══════════════════════════════════════════════════════════════════════
create or replace function kh_messages_rate_trigger()
  returns trigger language plpgsql as $body$
begin
  if not kh_check_rate('msg:' || new.group_code, 30, 60) then
    raise exception 'Rate limit exceeded — max 30 messages per group per minute';
  end if;
  return new;
end;
$body$;
drop   trigger if exists kh_messages_rate on kh_messages;
create trigger kh_messages_rate
  before insert on kh_messages
  for each row execute function kh_messages_rate_trigger();

create or replace function kh_messages_cap_trigger()
  returns trigger language plpgsql security definer as $body$
begin
  delete from kh_messages
    where group_code = new.group_code
      and id not in (
        select id from kh_messages
        where group_code = new.group_code
        order by ts desc
        limit 50
      );
  return null;
end;
$body$;
drop   trigger if exists kh_messages_cap on kh_messages;
create trigger kh_messages_cap
  after insert on kh_messages
  for each row execute function kh_messages_cap_trigger();

-- v8.3 STORAGE GUARD: cap kh_mail so it can't grow forever. Keep the newest
-- 60 messages per recipient (to_user). Mirrors the kh_messages cap.
create or replace function kh_mail_cap_trigger()
  returns trigger language plpgsql security definer as $body$
begin
  delete from kh_mail
    where to_user = new.to_user
      and id not in (
        select id from kh_mail
        where to_user = new.to_user
        order by ts desc
        limit 60
      );
  return null;
end;
$body$;
drop   trigger if exists kh_mail_cap on kh_mail;
create trigger kh_mail_cap
  after insert on kh_mail
  for each row execute function kh_mail_cap_trigger();

-- v8.3 STORAGE GUARD: cap kh_errors at ~600 newest rows globally so the
-- crash/diagnostics log from many users can't fill the database.
create or replace function kh_errors_cap_trigger()
  returns trigger language plpgsql security definer as $body$
begin
  if (random() < 0.05) then   -- only sweep ~1 insert in 20 (cheap)
    delete from kh_errors
      where id not in (select id from kh_errors order by date desc limit 600);
  end if;
  return null;
end;
$body$;
drop   trigger if exists kh_errors_cap on kh_errors;
create trigger kh_errors_cap
  after insert on kh_errors
  for each row execute function kh_errors_cap_trigger();

create or replace function kh_feedback_rate_trigger()
  returns trigger language plpgsql as $body$
begin
  if not kh_check_rate('fb:' || new.type, 10, 60) then
    raise exception 'Rate limit exceeded — max 10 feedback submissions per minute';
  end if;
  return new;
end;
$body$;
drop   trigger if exists kh_feedback_rate on kh_feedback;
create trigger kh_feedback_rate
  before insert on kh_feedback
  for each row execute function kh_feedback_rate_trigger();

-- ══════════════════════════════════════════════════════════════════════
-- 6. REALTIME — broadcast new messages over WebSockets
-- ══════════════════════════════════════════════════════════════════════
do $body$ begin
  alter publication supabase_realtime add table kh_messages;
exception when duplicate_object then null;
end $body$;

-- ══════════════════════════════════════════════════════════════════════
-- 7. RELOAD POSTGREST'S SCHEMA CACHE  (always last)
-- ══════════════════════════════════════════════════════════════════════
notify pgrst, 'reload schema';

-- Done. Wait ~30s, then re-run Admin → Diagnostics; everything should be green.
