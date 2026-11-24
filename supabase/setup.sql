-- Death tally for UMAD Wipe Review: visible and editable ONLY by the owner's FFLogs account.
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste this whole file -> Run. Safe to run again.
-- Then set the owner (bottom of this file).
--
-- How the lock works: the page sends the viewer's FFLogs login token with every tally call. These functions ask
-- FFLogs who that token belongs to (api/v2/user, currentUser) and only answer when it is the owner's FFLogs user ID.
-- The table itself can't be read or written with the public (publishable) key at all.

create extension if not exists http with schema extensions;

-- One row per death. `data` is the ledger entry the page builds (player, pull, mechanic, callout, blame, mechanical...).
create table if not exists public.tally_deaths (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.tally_deaths enable row level security;
drop policy if exists "anyone can read the tally" on public.tally_deaths;
revoke all on public.tally_deaths from anon, authenticated;

-- The FFLogs user ID allowed to see and edit the tally. RLS on and no policies: not readable through the API.
create table if not exists public.tally_owner (
  fflogs_user_id bigint primary key
);
alter table public.tally_owner enable row level security;
revoke all on public.tally_owner from anon, authenticated;

-- The old passcode lock (earlier version of this file) is replaced by the FFLogs check.
drop function if exists public.tally_check(text);
drop function if exists public.tally_upsert(text, jsonb);
drop function if exists public.tally_clear(text);
drop table if exists public.tally_secret;

-- Who is this FFLogs token? {"id": 123, "name": "..."} or null. Not callable from the API (internal only).
create or replace function public.tally_fflogs_user(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r extensions.http_response;
begin
  if coalesce(p_token, '') = '' then return null; end if;
  select * into r from extensions.http((
    'POST', 'https://www.fflogs.com/api/v2/user',
    array[extensions.http_header('Authorization', 'Bearer ' || p_token)],
    'application/json', '{"query":"{ userData { currentUser { id name } } }"}'
  )::extensions.http_request);
  if r.status <> 200 then return null; end if;
  return r.content::jsonb -> 'data' -> 'userData' -> 'currentUser';
exception when others then return null;
end $$;

-- Raises unless the token is the owner's FFLogs account.
create or replace function public.tally_require_owner(p_token text) returns void
language plpgsql security definer set search_path = public as $$
declare u jsonb := public.tally_fflogs_user(p_token);
begin
  if u is null or not exists (select 1 from public.tally_owner where fflogs_user_id = (u->>'id')::bigint) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end $$;

-- For the page: who is logged in, and are they the owner? Use the "id" here to set the owner below.
create or replace function public.tally_whoami(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare u jsonb := public.tally_fflogs_user(p_token);
begin
  if u is null then return null; end if;
  return u || jsonb_build_object('owner', exists (select 1 from public.tally_owner where fflogs_user_id = (u->>'id')::bigint));
end $$;

-- The whole tally as one JSON array (owner only).
create or replace function public.tally_load(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.tally_require_owner(p_token);
  return coalesce((select jsonb_agg(data order by key) from public.tally_deaths), '[]'::jsonb);
end $$;

-- Insert or replace deaths: p_rows is a JSON array of ledger entries (each has a "key"). Owner only.
create or replace function public.tally_upsert(p_token text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.tally_require_owner(p_token);
  insert into public.tally_deaths (key, data, updated_at)
    select r->>'key', r, now() from jsonb_array_elements(p_rows) r where coalesce(r->>'key', '') <> ''
  on conflict (key) do update set data = excluded.data, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Delete the whole tally (the page's "Clear tally" button). Owner only.
create or replace function public.tally_clear(p_token text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.tally_require_owner(p_token);
  delete from public.tally_deaths where true;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.tally_fflogs_user(text), public.tally_require_owner(text) from public, anon, authenticated;
revoke all on function public.tally_whoami(text), public.tally_load(text), public.tally_upsert(text, jsonb), public.tally_clear(text) from public;
grant execute on function public.tally_whoami(text), public.tally_load(text), public.tally_upsert(text, jsonb), public.tally_clear(text) to anon, authenticated;

-- >>> Set the owner: log in with FFLogs on the site, read your FFLogs user ID at the top right ("#12345"),
-- >>> then run this one line with that number:
-- insert into public.tally_owner (fflogs_user_id) values (12345) on conflict do nothing;
