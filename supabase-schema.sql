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
      raise exception 'Free accounts keep 1 saved preset. Upgrade to Studio for more.';
    end if;
  elsif user_plan = 'studio' then
    select count(*) into existing_count from public.presets where user_id = new.user_id;
    if existing_count >= 10 then
      raise exception 'Studio accounts keep 10 saved presets. Upgrade to Agency for unlimited presets.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists before_preset_insert on public.presets;
create trigger before_preset_insert
  before insert on public.presets
  for each row execute procedure public.enforce_preset_limit();

-- RLS controls WHO can write a preset row, but says nothing about WHAT is
-- in it. This validates config's shape and size before it's ever written —
-- a malicious or buggy client can no longer stuff arbitrary/oversized JSON
-- into it via a direct REST call. Bounds mirror what auth.js's
-- saveCurrentAsPreset() actually sends; adjust if that shape changes.
create or replace function public.validate_preset_config()
returns trigger as $$
declare
  cfg jsonb := new.config;
begin
  if new.name is null or length(new.name) < 1 or length(new.name) > 60 then
    raise exception 'Preset name must be 1-60 characters';
  end if;

  if jsonb_typeof(cfg) is distinct from 'object' then
    raise exception 'Preset config must be a JSON object';
  end if;

  -- Hard cap on the whole payload so no one can smuggle megabytes of JSON
  -- into a single preset row.
  if pg_column_size(cfg) > 10240 then
    raise exception 'Preset config is too large';
  end if;

  if cfg ? 'name' and (jsonb_typeof(cfg->'name') is distinct from 'string' or length(cfg->>'name') > 45) then
    raise exception 'Invalid preset config: name';
  end if;
  if cfg ? 'shortName' and (jsonb_typeof(cfg->'shortName') is distinct from 'string' or length(cfg->>'shortName') > 12) then
    raise exception 'Invalid preset config: shortName';
  end if;
  if cfg ? 'description' and (jsonb_typeof(cfg->'description') is distinct from 'string' or length(cfg->>'description') > 300) then
    raise exception 'Invalid preset config: description';
  end if;
  if cfg ? 'startUrl' and (jsonb_typeof(cfg->'startUrl') is distinct from 'string' or length(cfg->>'startUrl') > 500) then
    raise exception 'Invalid preset config: startUrl';
  end if;
  if cfg ? 'themeColor' and (cfg->>'themeColor') !~* '^#([0-9a-f]{3}|[0-9a-f]{6})$' then
    raise exception 'Invalid preset config: themeColor';
  end if;
  if cfg ? 'bgColor' and (cfg->>'bgColor') !~* '^#([0-9a-f]{3}|[0-9a-f]{6})$' then
    raise exception 'Invalid preset config: bgColor';
  end if;
  if cfg ? 'display' and (cfg->>'display') not in ('standalone', 'fullscreen', 'minimal-ui') then
    raise exception 'Invalid preset config: display';
  end if;
  if cfg ? 'orientation' and (cfg->>'orientation') not in ('any', 'portrait', 'landscape') then
    raise exception 'Invalid preset config: orientation';
  end if;
  if cfg ? 'strategy' and (cfg->>'strategy') not in ('cache-first', 'network-first', 'stale-while-revalidate') then
    raise exception 'Invalid preset config: strategy';
  end if;
  if cfg ? 'includeSplash' and jsonb_typeof(cfg->'includeSplash') is distinct from 'boolean' then
    raise exception 'Invalid preset config: includeSplash';
  end if;
  if cfg ? 'includeFavicon' and jsonb_typeof(cfg->'includeFavicon') is distinct from 'boolean' then
    raise exception 'Invalid preset config: includeFavicon';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists before_preset_validate on public.presets;
create trigger before_preset_validate
  before insert or update on public.presets
  for each row execute procedure public.validate_preset_config();

-- ---------------------------------------------------------------
-- builds: history of successful generations, so a signed-in user can
-- see recent builds and reload a config without re-uploading the icon
-- (the icon itself is never stored here — same as presets, this only
-- ever holds the text/color config, not image data).
-- ---------------------------------------------------------------
create table if not exists public.builds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  config jsonb not null,
  quality_score integer,
  created_at timestamptz not null default now()
);

create index if not exists builds_user_id_idx on public.builds(user_id, created_at desc);

alter table public.builds enable row level security;

drop policy if exists "Users can view their own builds" on public.builds;
create policy "Users can view their own builds"
  on public.builds for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own builds" on public.builds;
create policy "Users can insert their own builds"
  on public.builds for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own builds" on public.builds;
create policy "Users can delete their own builds"
  on public.builds for delete
  using (auth.uid() = user_id);

-- Same shape/size validation as presets, plus a sane bound on the score.
create or replace function public.validate_build_config()
returns trigger as $$
declare
  cfg jsonb := new.config;
begin
  if new.name is null or length(new.name) > 60 then
    raise exception 'Build name must be under 60 characters';
  end if;
  if jsonb_typeof(cfg) is distinct from 'object' then
    raise exception 'Build config must be a JSON object';
  end if;
  if pg_column_size(cfg) > 10240 then
    raise exception 'Build config is too large';
  end if;
  if new.quality_score is not null and (new.quality_score < 0 or new.quality_score > 100) then
    raise exception 'Invalid quality score';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists before_build_insert on public.builds;
create trigger before_build_insert
  before insert on public.builds
  for each row execute procedure public.validate_build_config();

-- Keeps history from growing unbounded per user (generous cap — this is
-- about preventing abuse, not limiting normal use).
create or replace function public.enforce_build_history_cap()
returns trigger as $$
begin
  delete from public.builds
  where user_id = new.user_id
    and id not in (
      select id from public.builds
      where user_id = new.user_id
      order by created_at desc
      limit 100
    );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists after_build_insert_cap on public.builds;
create trigger after_build_insert_cap
  after insert on public.builds
  for each row execute procedure public.enforce_build_history_cap();

-- ---------------------------------------------------------------
-- teams: Agency-tier shared workspace. The paying account becomes the
-- owner; members join via a single-use, expiring invite code. The
-- entire feature is: teammates can see each other's saved presets.
-- Membership is only ever changed through the security-definer
-- functions below — there is deliberately no insert/update/delete
-- policy on team_members for regular users, so joining or being added
-- to a team can't happen via a direct REST call, only through
-- create_team()/redeem_team_invite(), which enforce the actual rules
-- (agency plan required, one team per user, code must be valid).
-- ---------------------------------------------------------------
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My team',
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

-- gen_random_bytes() (used for invite codes below) needs pgcrypto —
-- Supabase projects usually have this on by default, but this makes
-- the script work standalone regardless.
create extension if not exists pgcrypto;

create table if not exists public.team_invites (
  code text primary key default replace(replace(replace(
    encode(gen_random_bytes(9), 'base64'), '+', '-'), '/', '_'), '=', ''),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_by uuid references auth.users(id),
  used_at timestamptz
);

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;

drop policy if exists "Members can view their team" on public.teams;
create policy "Members can view their team"
  on public.teams for select
  using (
    exists (
      select 1 from public.team_members m
      where m.team_id = teams.id and m.user_id = auth.uid()
    )
  );

drop policy if exists "Owner can rename their team" on public.teams;
create policy "Owner can rename their team"
  on public.teams for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "Members can view their team roster" on public.team_members;
create policy "Members can view their team roster"
  on public.team_members for select
  using (
    exists (
      select 1 from public.team_members me
      where me.team_id = team_members.team_id and me.user_id = auth.uid()
    )
  );

drop policy if exists "Members can view their team's invites" on public.team_invites;
create policy "Members can view their team's invites"
  on public.team_invites for select
  using (
    exists (
      select 1 from public.team_members m
      where m.team_id = team_invites.team_id and m.user_id = auth.uid()
    )
  );

-- create_team(): agency-plan only, one team per user, caller becomes owner.
create or replace function public.create_team(team_name text default 'My team')
returns uuid as $$
declare
  caller_plan text;
  new_team_id uuid;
begin
  select plan into caller_plan from public.profiles where id = auth.uid();
  if caller_plan is distinct from 'agency' then
    raise exception 'Teams are an Agency-plan feature';
  end if;
  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You already belong to a team';
  end if;
  insert into public.teams (owner_id, name)
    values (auth.uid(), coalesce(nullif(trim(team_name), ''), 'My team'))
    returning id into new_team_id;
  insert into public.team_members (team_id, user_id, role)
    values (new_team_id, auth.uid(), 'owner');
  return new_team_id;
end;
$$ language plpgsql security definer;

grant execute on function public.create_team(text) to authenticated;

-- create_team_invite(): only the team owner can mint invite codes, and only
-- while the team is under the 5-seat cap.
create or replace function public.create_team_invite(p_team_id uuid)
returns text as $$
declare
  is_owner boolean;
  member_count integer;
  new_code text;
begin
  select (owner_id = auth.uid()) into is_owner from public.teams where id = p_team_id;
  if is_owner is not true then
    raise exception 'Only the team owner can invite members';
  end if;
  select count(*) into member_count from public.team_members where team_id = p_team_id;
  if member_count >= 5 then
    raise exception 'This team is already at its 5-seat limit';
  end if;
  insert into public.team_invites (team_id, created_by)
    values (p_team_id, auth.uid())
    returning code into new_code;
  return new_code;
end;
$$ language plpgsql security definer;

grant execute on function public.create_team_invite(uuid) to authenticated;

-- redeem_team_invite(): joins the caller if the code is valid, unused,
-- unexpired, and the caller isn't already on a team.
create or replace function public.redeem_team_invite(p_code text)
returns uuid as $$
declare
  inv record;
begin
  select * into inv from public.team_invites where code = p_code for update;
  if inv is null then
    raise exception 'Invite code not found';
  end if;
  if inv.used_by is not null then
    raise exception 'This invite has already been used';
  end if;
  if inv.expires_at < now() then
    raise exception 'This invite has expired';
  end if;
  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You already belong to a team';
  end if;
  if (select count(*) from public.team_members where team_id = inv.team_id) >= 5 then
    raise exception 'This team is already at its 5-seat limit';
  end if;
  insert into public.team_members (team_id, user_id, role)
    values (inv.team_id, auth.uid(), 'member');
  update public.team_invites set used_by = auth.uid(), used_at = now()
    where code = p_code;
  return inv.team_id;
end;
$$ language plpgsql security definer;

grant execute on function public.redeem_team_invite(text) to authenticated;

-- Client code can't safely query auth.users directly (it's not exposed
-- through the normal REST API, and shouldn't be). This is the one
-- narrow, checked window into it: returns email addresses only for the
-- caller's own team, only if the caller is actually a member of it.
create or replace function public.get_team_roster(p_team_id uuid)
returns table(user_id uuid, email text, role text, joined_at timestamptz) as $$
begin
  if not exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = auth.uid()
  ) then
    raise exception 'Not a member of this team';
  end if;
  return query
    select tm.user_id, u.email, tm.role, tm.joined_at
    from public.team_members tm
    join auth.users u on u.id = tm.user_id
    where tm.team_id = p_team_id;
end;
$$ language plpgsql security definer;

grant execute on function public.get_team_roster(uuid) to authenticated;

-- Extends preset visibility to teammates (the actual point of a team —
-- shared brand presets across a small agency). Writing stays owner-only;
-- this only widens the SELECT policy, replacing the single-user one.
drop policy if exists "Users can view their own presets" on public.presets;
drop policy if exists "Users can view their own or team presets" on public.presets;
create policy "Users can view their own or team presets"
  on public.presets for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.team_members me
      join public.team_members them on them.team_id = me.team_id
      where me.user_id = auth.uid() and them.user_id = presets.user_id
    )
  );
