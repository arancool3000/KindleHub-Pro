-- ============================================================================
-- KindleHub — EMERGENCY Supabase lockdown
-- ============================================================================
-- WHY: the original RLS policies were `using (true)` on kh_users, so ANY client
-- holding the public anon key could `SELECT *` from kh_users and read every
-- user's `hash` and `state`. The `hash` is SHA-256(username+password) — it is
-- BOTH the login secret AND the AES key that decrypts that user's `state` blob.
-- `using (true)` on UPDATE also let anyone overwrite any row. Net result: every
-- account and all its synced data was readable/forgeable by anyone with the
-- (public) anon key.
--
-- WHAT THIS DOES: revokes ALL table access from the client roles (anon,
-- authenticated) on every kh_* table. Because ALL live traffic now runs on the
-- Cloudflare D1 worker, this does NOT affect the running app. The postgres
-- `service_role` (the secret service key in your dashboard) bypasses RLS and
-- keeps its grants, so a final data migration via the service key still works.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → paste ALL of this → Run.
-- Verify afterwards with the SELECT at the bottom (should show no anon grants).
--
-- ⚠ THIS IS A STOPGAP. The permanent fix is to finish migrating to D1 and then
-- DELETE the Supabase project (Project Settings → General → Delete project).
-- And see the ROTATION note at the very bottom — locking the DB does NOT
-- un-leak hashes that may already have been scraped.
-- ============================================================================

begin;

-- 1) Hard revoke: strip anon + authenticated of every privilege on kh_* tables.
--    (service_role is untouched, so migration/admin via the service key works.)
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename like 'kh\_%'
  loop
    execute format('revoke all privileges on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- 2) Defence in depth: keep RLS ON and replace every permissive policy with an
--    explicit deny for the client roles. (With the grants gone this is belt-and-
--    suspenders, but it means re-granting a table by mistake still won't reopen
--    the hole.) service_role bypasses RLS entirely.
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public' and tablename like 'kh\_%'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
  for r in
    select tablename from pg_tables
    where schemaname = 'public' and tablename like 'kh\_%'
  loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('alter table public.%I force row level security', r.tablename);
    -- A single restrictive "deny all" policy for the client roles.
    execute format($f$create policy "kh_locked_deny" on public.%I as restrictive
                       for all to anon, authenticated using (false) with check (false)$f$, r.tablename);
  end loop;
end $$;

-- 3) Belt further: revoke EXECUTE on the SECURITY DEFINER RPCs from the client
--    roles too, so the token-gated admin functions can't even be called by anon.
--    (Admin work should be done via the D1 worker now.)
do $$
declare f text;
begin
  for f in
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'kh\_%'
  loop
    begin
      execute format('revoke all on function public.%I from anon, authenticated', f);
    exception when others then null; -- overloaded/edge signatures: skip
    end;
  end loop;
end $$;

commit;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
-- Expect ZERO rows: no table privileges remain for anon/authenticated on kh_*.
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name like 'kh\_%'
  and grantee in ('anon', 'authenticated')
order by table_name, grantee;

-- ── AFTER LOCKING ───────────────────────────────────────────────────────────
-- 1. Finish the one-time migration to Cloudflare D1 if you haven't. Do it with
--    the SERVICE key (dashboard/wrangler) — it bypasses this lockdown. The
--    in-app migration tool uses the anon key and will now (correctly) fail.
-- 2. DELETE the Supabase project once D1 has the data.
--
-- ── ⚠ CREDENTIAL ROTATION (do not skip) ─────────────────────────────────────
-- KindleHub's `hash` = SHA-256(username+password) is the SAME auth secret on the
-- D1 backend too. Any hash scraped from Supabase while it was open ALSO unlocks
-- that account on D1 and decrypts that user's old synced state. Locking the DB
-- stops NEW scraping; it cannot un-leak what was already taken. Therefore treat
-- the accounts as potentially compromised and have users CHANGE THEIR PASSWORD
-- (which regenerates the hash and re-keys their state). If you can, check the
-- Supabase logs/analytics for large historical reads of kh_users to gauge real
-- exposure before deciding how hard to push the reset.
