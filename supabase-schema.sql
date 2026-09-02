-- PWAfy — Supabase schema
-- Run this once in your Supabase project's SQL editor (Project -> SQL Editor -> New query).
-- Free tier covers this comfortably (500MB DB, 50k monthly active users).
-- Auth itself (magic-link email sign-in) needs no extra setup — Supabase Auth
-- handles that once you paste your project URL + anon key into CONFIG in js/state.js.
--
-- This version is idempotent: every object is guarded with IF EXISTS / IF NOT
-- EXISTS (or a DROP before CREATE, for objects Postgres doesn't let you guard
-- directly, like policies). You can re-run the whole file any number of
-- times — on a fresh project or a partially-applied one — without hitting
-- "already exists" errors.

-- ---------------------------------------------------------------
-- profiles: one row per user, tracks their plan.
-- Only the Worker's Paystack webhook (using the service-role key, which
-- bypasses RLS) is allowed to UPGRADE `plan`. Users may downgrade their
-- own plan to 'free' themselves — see the "Users can cancel their own
-- plan" policy below — that's the only self-service write a regular
-- user gets on this table.
-- ---------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','studio','agency')),
  -- When a paid plan expires. Set by the webhook to now() + 30 days on every
  -- successful charge/transfer. The Worker's daily cron job (see the
  -- `scheduled` handler in proxy-worker.js) downgrades any profile whose
  -- plan_expires_at has passed back to 'free'. Always null on the free plan.
  plan_expires_at timestamptz,
  -- Lifetime count of ZIP builds generated while signed in. Only enforced
  -- against the free-plan cap (1) — studio/agency stay unlimited, but usage
  -- is still tracked. Incremented atomically by consume_build_credit() below
  -- so two tabs open at once can't both slip past the free-tier limit.
  builds_used integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Users can write their OWN row only, and only to move themselves to
-- 'free' with no expiry — a self-serve cancel. WITH CHECK validates the
-- resulting row, so this can never be used to grant studio/agency access;
-- only the webhook (service-role key, bypasses RLS entirely) can do that.
drop policy if exists "Users can cancel their own plan" on public.profiles;
create policy "Users can cancel their own plan"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and plan = 'free' and plan_expires_at is null);

-- No insert policy for regular users on purpose: the profile row is
-- created by the trigger below.

-- Auto-create a profile row the moment someone signs up.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, plan) values (new.id, 'free')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Keep updated_at current on every write to a profile row.
create or replace function public.touch_profile_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists on_profile_updated on public.profiles;
create trigger on_profile_updated
  before update on public.profiles
  for each row execute procedure public.touch_profile_updated_at();

-- Speeds up the Worker's daily "who has expired" cron query.
create index if not exists profiles_plan_expiry_idx
  on public.profiles (plan, plan_expires_at)
  where plan <> 'free';

-- ---------------------------------------------------------------
-- consume_build_credit(): call this right before generating a ZIP.
-- Returns true if the build is allowed (and records it), false if a
-- free-plan user has already used their one lifetime build. Runs
-- SECURITY DEFINER so it can update builds_used even though the
-- profiles UPDATE policy above only allows plan changes — this
-- function is the only thing permitted to touch builds_used, and it
-- only ever touches the caller's own row (auth.uid()).
-- ---------------------------------------------------------------
create or replace function public.consume_build_credit()
returns boolean as $$
declare
  current_plan text;
  current_used integer;
begin
  select plan, builds_used into current_plan, current_used
    from public.profiles
    where id = auth.uid()
    for update;

  if current_plan is null then
    -- No profile row for this user (shouldn't happen) — fail closed.
    return false;
  end if;

  if current_plan = 'free' and current_used >= 1 then
    return false;
  end if;

  update public.profiles set builds_used = builds_used + 1 where id = auth.uid();
  return true;
end;
$$ language plpgsql security definer;

grant execute on function public.consume_build_credit() to authenticated;

-- ---------------------------------------------------------------
-- presets: saved brand settings per user
-- ---------------------------------------------------------------
create table if not exists public.presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  config jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists presets_user_id_idx on public.presets(user_id);

alter table public.presets enable row level security;

drop policy if exists "Users can view their own presets" on public.presets;
create policy "Users can view their own presets"
  on public.presets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own presets" on public.presets;
create policy "Users can insert their own presets"
  on public.presets for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own presets" on public.presets;
create policy "Users can update their own presets"
  on public.presets for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own presets" on public.presets;
create policy "Users can delete their own presets"
  on public.presets for delete
  using (auth.uid() = user_id);

-- The client-side check in auth.js (free plan -> max 1 preset) is UX only —
-- anyone can call the Supabase REST API directly with the public anon key
-- and bypass it. This trigger is the real enforcement: it runs on every
-- insert no matter how it's made.
create or replace function public.enforce_preset_limit()
returns trigger as $$
declare
  user_plan text;
  existing_count integer;
begin
  select plan into user_plan from public.profiles where id = new.user_id;

  if user_plan = 'free' then
    select count(*) into existing_count from public.presets where user_id = new.user_id;
    if existing_count >= 1 then
      raise exception 'Free accounts keep 1 saved preset. Upgrade to Studio for unlimited presets.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists before_preset_insert on public.presets;
create trigger before_preset_insert
  before insert on public.presets
  for each row execute procedure public.enforce_preset_limit();
