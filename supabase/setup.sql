-- Shared death tally for UMAD Wipe Review.
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste this file -> change the passcode at the bottom -> Run.
--
-- Everyone with the page can READ the tally. Writes only go through the functions below, which check the static's
-- passcode. The passcode is stored as a bcrypt hash and the table holding it can't be read through the public API.

create extension if not exists pgcrypto with schema extensions;

-- One row per death. `data` is the ledger entry the page builds (player, pull, mechanic, callout, blame, mechanical...).
create table if not exists public.tally_deaths (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.tally_deaths enable row level security;
drop policy if exists "anyone can read the tally" on public.tally_deaths;
create policy "anyone can read the tally" on public.tally_deaths for select to anon, authenticated using (true);
grant select on public.tally_deaths to anon, authenticated;
-- No insert/update/delete policy: the public key can't write the table directly, only through the functions below.

-- The passcode hash. RLS on and no policies: nothing outside these functions can read it.
create table if not exists public.tally_secret (
  id   int primary key default 1 check (id = 1),
  hash text not null
);
alter table public.tally_secret enable row level security;
revoke all on public.tally_secret from anon, authenticated;

create or replace function public.tally_check(p_code text) returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists (select 1 from public.tally_secret where hash = extensions.crypt(p_code, hash));
$$;

-- Insert or replace deaths: p_rows is a JSON array of ledger entries (each has a "key").
create or replace function public.tally_upsert(p_code text, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not public.tally_check(p_code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  insert into public.tally_deaths (key, data, updated_at)
    select r->>'key', r, now() from jsonb_array_elements(p_rows) r where coalesce(r->>'key', '') <> ''
  on conflict (key) do update set data = excluded.data, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Delete the whole tally (the page's "Clear tally" button).
create or replace function public.tally_clear(p_code text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not public.tally_check(p_code) then raise exception 'Wrong passcode' using errcode = '28000'; end if;
  delete from public.tally_deaths where true;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.tally_check(text), public.tally_upsert(text, jsonb), public.tally_clear(text) from public;
grant execute on function public.tally_check(text), public.tally_upsert(text, jsonb), public.tally_clear(text) to anon, authenticated;

-- >>> Set the static's passcode here (re-run just this statement later to change it). <<<
insert into public.tally_secret (id, hash) values (1, extensions.crypt('CHANGE-ME',extensions.gen_salt('bf')))
on conflict (id) do update set hash = excluded.hash;
