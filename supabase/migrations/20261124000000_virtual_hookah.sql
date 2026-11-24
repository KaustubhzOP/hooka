-- =============================================================================
-- Virtual Hookah backend (Supabase / Postgres)
--
-- Security model
--  * Auth is Supabase Auth (JWT). Postgres reads the caller from the JWT via
--    auth.uid(); every table has row-level security (RLS) enabled.
--  * Clients never write tables directly: there are no INSERT/UPDATE/DELETE
--    policies. All writes go through the SECURITY DEFINER functions below,
--    which validate input, check permissions and apply rate limits.
--  * Functions use `set search_path = ''` and fully-qualified names.
--  * Room realtime channels are private: only room members may join them
--    (policies on realtime.messages).
--  * No video, images or face data are ever stored: calls are peer-to-peer.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- -----------------------------------------------------------------------------
-- Rate limiting (private, not reachable through the API)
-- -----------------------------------------------------------------------------
create table if not exists private.rate_limits (
  user_id uuid not null,
  action text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (user_id, action)
);

create or replace function private.rate_limit(p_action text, p_max int, p_window_seconds int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row private.rate_limits%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  insert into private.rate_limits as r (user_id, action, window_start, count)
  values (v_uid, p_action, now(), 1)
  on conflict (user_id, action) do update
    set count = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.count + 1 end,
        window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning * into v_row;
  if v_row.count > p_max then raise exception 'rate_limited'; end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Profiles: one per user, holds the unique username
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  avatar text not null default '🙂' check (char_length(avatar) between 1 and 8),
  created_at timestamptz not null default now(),
  username_changed_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles readable by signed-in users" on public.profiles;
create policy "profiles readable by signed-in users" on public.profiles
  for select to authenticated using (true);

create or replace function private.require_profile()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from public.profiles where id = v_uid) then raise exception 'username_required'; end if;
  return v_uid;
end;
$$;

-- Usernames: 3–20 chars, a–z 0–9 _, case-insensitive (stored lower-case), not reserved, not rude.
create or replace function private.username_problem(p_username text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(trim(p_username));
  bad text;
begin
  if v is null or v !~ '^[a-z0-9_]{3,20}$' then return 'username_invalid'; end if;
  if v ~ '^_|_$' or v ~ '__' then return 'username_invalid'; end if;
  if v = any (array['admin','administrator','root','support','help','moderator','mod','staff','system',
                    'official','virtualhookah','virtual_hookah','hookah','null','undefined','me','you',
                    'anonymous','guest','player','owner','team','security','api','www']) then
    return 'username_reserved';
  end if;
  foreach bad in array array['fuck','shit','bitch','cunt','nigg','fag','rape','nazi','hitler','porn','dick','pussy','whore','slut','retard'] loop
    if position(bad in v) > 0 then return 'username_inappropriate'; end if;
  end loop;
  return null;
end;
$$;

create or replace function public.username_available(p_username text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if private.username_problem(p_username) is not null then return false; end if;
  return not exists (select 1 from public.profiles where username = lower(trim(p_username)) and id <> auth.uid());
end;
$$;

-- Create or change the caller's profile. Changing the name is limited to once a week.
create or replace function public.claim_username(p_username text, p_avatar text default null)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := lower(trim(p_username));
  v_problem text;
  v_profile public.profiles;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  perform private.rate_limit('claim_username', 10, 3600);
  v_problem := private.username_problem(v_name);
  if v_problem is not null then raise exception '%', v_problem; end if;
  if p_avatar is not null and char_length(p_avatar) not between 1 and 8 then raise exception 'avatar_invalid'; end if;

  select * into v_profile from public.profiles where id = v_uid;
  begin
    if v_profile.id is null then
      insert into public.profiles (id, username, avatar)
      values (v_uid, v_name, coalesce(p_avatar, '🙂'))
      returning * into v_profile;
    else
      if v_profile.username <> v_name and v_profile.username_changed_at > now() - interval '7 days' then
        raise exception 'username_change_too_soon';
      end if;
      update public.profiles
         set username = v_name,
             avatar = coalesce(p_avatar, avatar),
             username_changed_at = case when username <> v_name then now() else username_changed_at end
       where id = v_uid
      returning * into v_profile;
    end if;
  exception when unique_violation then
    raise exception 'username_taken';
  end;
  return v_profile;
end;
$$;

create or replace function public.set_avatar(p_avatar text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  if p_avatar is null or char_length(p_avatar) not between 1 and 8 then raise exception 'avatar_invalid'; end if;
  update public.profiles set avatar = p_avatar where id = v_uid;
end;
$$;

create or replace function public.touch_presence()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles set last_seen = now() where id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- Friends
-- -----------------------------------------------------------------------------
create table if not exists public.friendships (
  id bigint generated always as identity primary key,
  requester uuid not null references public.profiles (id) on delete cascade,
  addressee uuid not null references public.profiles (id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee on public.friendships (addressee);
alter table public.friendships enable row level security;

-- You see your own friendships; a block is only visible to the person who blocked.
drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships" on public.friendships
  for select to authenticated
  using (auth.uid() = requester or (auth.uid() = addressee and status <> 'blocked'));

create or replace function private.is_blocked(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships
     where status = 'blocked'
       and least(requester, addressee) = least(a, b)
       and greatest(requester, addressee) = greatest(a, b));
$$;

create or replace function private.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships
     where status = 'accepted'
       and least(requester, addressee) = least(a, b)
       and greatest(requester, addressee) = greatest(a, b));
$$;

create or replace function public.search_users(p_query text)
returns table (id uuid, username text, avatar text, relation text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := private.require_profile();
  v_q text := lower(trim(p_query));
begin
  if v_q is null or char_length(v_q) < 2 or char_length(v_q) > 20 or v_q !~ '^[a-z0-9_]+$' then return; end if;
  return query
    select p.id, p.username, p.avatar,
           coalesce((select case
                        when f.status = 'accepted' then 'friend'
                        when f.status = 'pending' and f.requester = v_uid then 'outgoing'
                        when f.status = 'pending' then 'incoming'
                        else 'blocked' end
                       from public.friendships f
                      where least(f.requester, f.addressee) = least(v_uid, p.id)
                        and greatest(f.requester, f.addressee) = greatest(v_uid, p.id)), 'none') as relation
      from public.profiles p
     where p.username like v_q || '%'
       and p.id <> v_uid
       and not private.is_blocked(v_uid, p.id)
     order by p.username = v_q desc, char_length(p.username), p.username
     limit 20;
end;
$$;

create or replace function public.send_friend_request(p_username text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_target uuid;
  v_row public.friendships;
begin
  perform private.rate_limit('friend_request', 30, 3600);
  select id into v_target from public.profiles where username = lower(trim(p_username));
  if v_target is null then raise exception 'user_not_found'; end if;
  if v_target = v_uid then raise exception 'cannot_friend_self'; end if;
  if private.is_blocked(v_uid, v_target) then raise exception 'user_not_found'; end if;

  select * into v_row from public.friendships
   where least(requester, addressee) = least(v_uid, v_target)
     and greatest(requester, addressee) = greatest(v_uid, v_target);
  if v_row.id is null then
    insert into public.friendships (requester, addressee, status) values (v_uid, v_target, 'pending');
    return 'requested';
  elsif v_row.status = 'accepted' then
    return 'already_friends';
  elsif v_row.requester = v_uid then
    return 'already_requested';
  else
    -- they already asked you: accept
    update public.friendships set status = 'accepted', updated_at = now() where id = v_row.id;
    return 'accepted';
  end if;
end;
$$;

create or replace function public.respond_friend_request(p_request_id bigint, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  if p_accept then
    update public.friendships set status = 'accepted', updated_at = now()
     where id = p_request_id and addressee = v_uid and status = 'pending';
  else
    delete from public.friendships where id = p_request_id and addressee = v_uid and status = 'pending';
  end if;
  if not found then raise exception 'request_not_found'; end if;
end;
$$;

-- Unfriend, cancel an outgoing request, or unblock.
create or replace function public.remove_friend(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  delete from public.friendships
   where least(requester, addressee) = least(v_uid, p_user_id)
     and greatest(requester, addressee) = greatest(v_uid, p_user_id)
     and (status <> 'blocked' or requester = v_uid);
end;
$$;

create or replace function public.block_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  if p_user_id = v_uid then raise exception 'cannot_block_self'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'user_not_found'; end if;
  delete from public.friendships
   where least(requester, addressee) = least(v_uid, p_user_id)
     and greatest(requester, addressee) = greatest(v_uid, p_user_id);
  insert into public.friendships (requester, addressee, status) values (v_uid, p_user_id, 'blocked');
  -- also leave any room you share with them? no: you can leave yourself; they can't see you in search any more.
end;
$$;

create or replace function public.my_friends()
returns table (request_id bigint, user_id uuid, username text, avatar text, status text, direction text, last_seen timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id,
         p.id, p.username, p.avatar,
         f.status,
         case when f.requester = auth.uid() then 'outgoing' else 'incoming' end,
         case when f.status = 'accepted' then p.last_seen end
    from public.friendships f
    join public.profiles p on p.id = case when f.requester = auth.uid() then f.addressee else f.requester end
   where (f.requester = auth.uid() or f.addressee = auth.uid())
     and (f.status <> 'blocked' or f.requester = auth.uid())
   order by f.status, p.username;
$$;

-- -----------------------------------------------------------------------------
-- Rooms (online multiplayer, 2–5 players, each on their own device)
-- -----------------------------------------------------------------------------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{8}$'),
  host_id uuid not null references public.profiles (id) on delete cascade,
  mode text not null default 'pass' check (mode in ('pass', 'live')),
  challenge text not null default 'score' check (challenge in ('score', 'rings', 'hold', 'tricks')),
  rounds int not null default 3 check (rounds between 1 and 10),
  max_players int not null default 5 check (max_players between 2 and 5),
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '6 hours'
);
alter table public.rooms enable row level security;

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  seat int not null check (seat between 0 and 4),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id),
  unique (room_id, seat)
);
alter table public.room_members enable row level security;

create table if not exists public.room_invites (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms (id) on delete cascade,
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (room_id, to_user)
);
create index if not exists room_invites_to on public.room_invites (to_user);
alter table public.room_invites enable row level security;

create or replace function private.is_room_member(p_room uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.room_members where room_id = p_room and user_id = p_user);
$$;

drop policy if exists "members and invitees see rooms" on public.rooms;
create policy "members and invitees see rooms" on public.rooms
  for select to authenticated
  using (private.is_room_member(rooms.id, auth.uid())
         or exists (select 1 from public.room_invites i where i.room_id = rooms.id and i.to_user = auth.uid()));

drop policy if exists "members see room members" on public.room_members;
create policy "members see room members" on public.room_members
  for select to authenticated
  using (private.is_room_member(room_id, auth.uid()));

drop policy if exists "see own invites" on public.room_invites;
create policy "see own invites" on public.room_invites
  for select to authenticated
  using (to_user = auth.uid() or from_user = auth.uid());

create or replace function private.new_room_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- no 0/O/1/I
  v text := '';
  b bytea := extensions.gen_random_bytes(8);
begin
  for i in 0..7 loop
    v := v || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return v;
end;
$$;

create or replace function public.create_room(p_mode text default 'pass', p_challenge text default 'score',
                                              p_rounds int default 3, p_max_players int default 5)
returns table (id uuid, code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := private.require_profile();
  v_room public.rooms;
begin
  perform private.rate_limit('create_room', 20, 3600);
  if p_mode not in ('pass', 'live') then raise exception 'invalid_mode'; end if;
  if p_challenge not in ('score', 'rings', 'hold', 'tricks') then raise exception 'invalid_challenge'; end if;
  if p_rounds not between 1 and 10 then raise exception 'invalid_rounds'; end if;
  if p_max_players not between 2 and 5 then raise exception 'invalid_max_players'; end if;
  for attempt in 1..5 loop
    begin
      insert into public.rooms (code, host_id, mode, challenge, rounds, max_players)
      values (private.new_room_code(), v_uid, p_mode, p_challenge, p_rounds, p_max_players)
      returning * into v_room;
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;
  insert into public.room_members (room_id, user_id, seat) values (v_room.id, v_uid, 0);
  return query select v_room.id, v_room.code;
end;
$$;

create or replace function public.join_room(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_room public.rooms;
  v_seat int;
begin
  perform private.rate_limit('join_room', 60, 3600);
  select * into v_room from public.rooms where code = upper(trim(p_code)) for update;
  if v_room.id is null or v_room.expires_at < now() or v_room.status = 'finished' then raise exception 'room_not_found'; end if;
  if private.is_room_member(v_room.id, v_uid) then return v_room.id; end if;
  if v_room.status <> 'lobby' then raise exception 'room_already_started'; end if;
  if exists (select 1 from public.room_members m where m.room_id = v_room.id and private.is_blocked(m.user_id, v_uid)) then
    raise exception 'room_not_found';
  end if;
  select min(s) into v_seat
    from generate_series(0, v_room.max_players - 1) s
   where not exists (select 1 from public.room_members m where m.room_id = v_room.id and m.seat = s);
  if v_seat is null then raise exception 'room_full'; end if;
  insert into public.room_members (room_id, user_id, seat) values (v_room.id, v_uid, v_seat);
  delete from public.room_invites where room_id = v_room.id and to_user = v_uid;
  update public.rooms set updated_at = now() where id = v_room.id;
  return v_room.id;
end;
$$;

create or replace function public.leave_room(p_room uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_next uuid;
begin
  delete from public.room_members where room_id = p_room and user_id = v_uid;
  if not found then return; end if;
  select user_id into v_next from public.room_members where room_id = p_room order by seat limit 1;
  if v_next is null then
    delete from public.rooms where id = p_room;
  else
    update public.rooms set host_id = v_next, updated_at = now() where id = p_room and host_id = v_uid;
  end if;
end;
$$;

create or replace function public.invite_to_room(p_room uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  perform private.rate_limit('room_invite', 60, 3600);
  if not private.is_room_member(p_room, v_uid) then raise exception 'not_room_member'; end if;
  if not private.are_friends(v_uid, p_user_id) then raise exception 'not_friends'; end if;
  if private.is_room_member(p_room, p_user_id) then return; end if;
  insert into public.room_invites (room_id, from_user, to_user) values (p_room, v_uid, p_user_id)
  on conflict (room_id, to_user) do update set created_at = now(), from_user = excluded.from_user;
end;
$$;

create or replace function public.decline_invite(p_invite_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.room_invites where id = p_invite_id and to_user = auth.uid();
$$;

create or replace function public.my_invites()
returns table (invite_id bigint, room_id uuid, code text, from_username text, from_avatar text, mode text, challenge text, players bigint, max_players int, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, r.id, r.code, p.username, p.avatar, r.mode, r.challenge,
         (select count(*) from public.room_members m where m.room_id = r.id), r.max_players, i.created_at
    from public.room_invites i
    join public.rooms r on r.id = i.room_id
    join public.profiles p on p.id = i.from_user
   where i.to_user = auth.uid() and r.status = 'lobby' and r.expires_at > now()
   order by i.created_at desc;
$$;

-- Host-only: change settings while in the lobby, start, finish.
create or replace function public.update_room(p_room uuid, p_status text default null, p_mode text default null,
                                              p_challenge text default null, p_rounds int default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room for update;
  if v_room.id is null or v_room.host_id <> v_uid then raise exception 'not_room_host'; end if;
  if p_status is not null and p_status not in ('lobby', 'playing', 'finished') then raise exception 'invalid_status'; end if;
  if p_mode is not null and p_mode not in ('pass', 'live') then raise exception 'invalid_mode'; end if;
  if p_challenge is not null and p_challenge not in ('score', 'rings', 'hold', 'tricks') then raise exception 'invalid_challenge'; end if;
  if p_rounds is not null and p_rounds not between 1 and 10 then raise exception 'invalid_rounds'; end if;
  if p_status = 'playing' and (select count(*) from public.room_members where room_id = p_room) < 2 then
    raise exception 'need_two_players';
  end if;
  update public.rooms
     set status = coalesce(p_status, status), mode = coalesce(p_mode, mode),
         challenge = coalesce(p_challenge, challenge), rounds = coalesce(p_rounds, rounds), updated_at = now()
   where id = p_room;
end;
$$;

create or replace function public.room_state(p_room uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  if not private.is_room_member(p_room, v_uid) then raise exception 'not_room_member'; end if;
  return (
    select jsonb_build_object(
      'id', r.id, 'code', r.code, 'host_id', r.host_id, 'mode', r.mode, 'challenge', r.challenge,
      'rounds', r.rounds, 'max_players', r.max_players, 'status', r.status,
      'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'username', p.username, 'avatar', p.avatar, 'seat', m.seat) order by m.seat)
                             from public.room_members m join public.profiles p on p.id = m.user_id
                            where m.room_id = r.id), '[]'::jsonb))
      from public.rooms r where r.id = p_room);
end;
$$;

-- -----------------------------------------------------------------------------
-- Games and scores (server-side plausibility checks against cheating)
-- -----------------------------------------------------------------------------
create table if not exists public.game_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  mode text not null check (mode in ('solo', 'online')),
  room_id uuid references public.rooms (id) on delete set null,
  started_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index if not exists game_sessions_user on public.game_sessions (user_id, started_at desc);
alter table public.game_sessions enable row level security;
drop policy if exists "see own sessions" on public.game_sessions;
create policy "see own sessions" on public.game_sessions for select to authenticated using (user_id = auth.uid());

create table if not exists public.scores (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid not null unique references public.game_sessions (id) on delete cascade,
  mode text not null check (mode in ('solo', 'online')),
  room_id uuid references public.rooms (id) on delete set null,
  score int not null check (score between 0 and 200000),
  rings int not null check (rings >= 0),
  best_combo int not null check (best_combo >= 0),
  longest_hold real not null check (longest_hold >= 0),
  hits int not null check (hits >= 0),
  created_at timestamptz not null default now()
);
create index if not exists scores_rank on public.scores (score desc);
create index if not exists scores_user on public.scores (user_id, created_at desc);
create index if not exists scores_week on public.scores (created_at, score desc);
alter table public.scores enable row level security;
drop policy if exists "see own scores" on public.scores;
create policy "see own scores" on public.scores for select to authenticated using (user_id = auth.uid());

create or replace function public.start_game(p_mode text default 'solo', p_room uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_id uuid;
begin
  perform private.rate_limit('start_game', 120, 3600);
  if p_mode not in ('solo', 'online') then raise exception 'invalid_mode'; end if;
  if p_mode = 'online' and (p_room is null or not private.is_room_member(p_room, v_uid)) then raise exception 'not_room_member'; end if;
  insert into public.game_sessions (user_id, mode, room_id) values (v_uid, p_mode, case when p_mode = 'online' then p_room end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Limits used by the plausibility checks (mirror the game rules in src/game.ts and src/machine.ts):
-- a hit takes ≥ 1.5 s, ≤ 14 rings per inhale, ≤ 1,600 points per hit, holds ≤ 15 s.
create or replace function public.submit_score(p_session uuid, p_score int, p_rings int, p_best_combo int,
                                               p_longest_hold real, p_hits int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_profile();
  v_s public.game_sessions;
  v_secs double precision;
  v_rank bigint;
  v_best int;
begin
  perform private.rate_limit('submit_score', 60, 3600);
  select * into v_s from public.game_sessions where id = p_session and user_id = v_uid for update;
  if v_s.id is null then raise exception 'session_not_found'; end if;
  if v_s.submitted_at is not null then raise exception 'already_submitted'; end if;
  v_secs := extract(epoch from now() - v_s.started_at);
  if v_secs > 6 * 3600 then raise exception 'session_expired'; end if;

  if p_score is null or p_rings is null or p_best_combo is null or p_longest_hold is null or p_hits is null
     or p_score < 0 or p_rings < 0 or p_best_combo < 0 or p_longest_hold < 0 or p_hits < 0
     or p_hits > floor(v_secs / 1.5) + 1
     or p_best_combo > least(p_rings, 14)
     or p_rings > p_hits * 14
     or p_longest_hold > 15
     or p_score > p_hits * 1600
     or p_score > 200000 then
    raise exception 'implausible_score';
  end if;

  update public.game_sessions set submitted_at = now() where id = p_session;
  if p_hits = 0 or p_score = 0 then return jsonb_build_object('saved', false); end if;

  insert into public.scores (user_id, session_id, mode, room_id, score, rings, best_combo, longest_hold, hits)
  values (v_uid, p_session, v_s.mode, v_s.room_id, p_score, p_rings, p_best_combo, p_longest_hold, p_hits);

  select max(score) into v_best from public.scores where user_id = v_uid;
  select count(*) + 1 into v_rank from (
    select user_id, max(score) best from public.scores group by user_id) t where t.best > v_best;
  return jsonb_build_object('saved', true, 'best', v_best, 'rank', v_rank, 'personal_best', p_score >= v_best);
end;
$$;

-- Leaderboard: best score per player. p_period: 'all' | 'week'. p_scope: 'global' | 'friends'.
create or replace function public.leaderboard(p_period text default 'all', p_scope text default 'global', p_limit int default 50)
returns table (rank bigint, user_id uuid, username text, avatar text, best_score int, best_combo int, longest_hold real, games bigint, is_me boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare v_uid uuid := auth.uid();
begin
  if p_period not in ('all', 'week') or p_scope not in ('global', 'friends') then raise exception 'invalid_leaderboard'; end if;
  if p_scope = 'friends' and v_uid is null then return; end if;
  return query
    with s as (
      select sc.user_id, max(sc.score) as best_score, max(sc.best_combo) as best_combo,
             max(sc.longest_hold) as longest_hold, count(*) as games
        from public.scores sc
       where (p_period = 'all' or sc.created_at >= date_trunc('week', now()))
         and (p_scope = 'global'
              or sc.user_id = v_uid
              or private.are_friends(v_uid, sc.user_id))
         and (v_uid is null or not private.is_blocked(v_uid, sc.user_id))
       group by sc.user_id
    ), ranked as (
      select rank() over (order by s.best_score desc, s.best_combo desc) as rank, s.*
        from s
    )
    select r.rank, r.user_id, p.username, p.avatar, r.best_score, r.best_combo, r.longest_hold, r.games,
           (r.user_id = v_uid)
      from ranked r join public.profiles p on p.id = r.user_id
     where r.rank <= least(greatest(p_limit, 1), 100) or r.user_id = v_uid
     order by r.rank, p.username;
end;
$$;

-- -----------------------------------------------------------------------------
-- Reports and account deletion
-- -----------------------------------------------------------------------------
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null references public.profiles (id) on delete cascade,
  reported uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (char_length(reason) between 3 and 500),
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;   -- no policies: only admins (service role) can read

create or replace function public.report_user(p_user_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := private.require_profile();
begin
  perform private.rate_limit('report', 10, 3600);
  if p_user_id = v_uid then raise exception 'cannot_report_self'; end if;
  if p_reason is null or char_length(trim(p_reason)) not between 3 and 500 then raise exception 'reason_invalid'; end if;
  insert into public.reports (reporter, reported, reason) values (v_uid, p_user_id, trim(p_reason));
end;
$$;

-- Deletes the caller's account and everything tied to it (profile, friends, scores, rooms).
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  delete from private.rate_limits where user_id = v_uid;
  delete from auth.users where id = v_uid;
end;
$$;

-- -----------------------------------------------------------------------------
-- Realtime: private room channels "room:<uuid>" are only for room members,
-- private user channels "user:<uuid>" only for that user.
-- -----------------------------------------------------------------------------
create or replace function private.can_use_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_topic is null then return false; end if;
  if p_topic ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return private.is_room_member(substr(p_topic, 6)::uuid, v_uid);
  end if;
  if p_topic ~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return substr(p_topic, 6)::uuid = v_uid;
  end if;
  return false;
end;
$$;

drop policy if exists "room members receive" on realtime.messages;
create policy "room members receive" on realtime.messages
  for select to authenticated using (private.can_use_topic(realtime.topic()));
drop policy if exists "room members send" on realtime.messages;
create policy "room members send" on realtime.messages
  for insert to authenticated with check (private.can_use_topic(realtime.topic()));

-- Live updates for friend requests and room invites (RLS still applies to what each user receives).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.friendships; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_invites; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Permissions: lock everything down, then open exactly what the app needs.
-- -----------------------------------------------------------------------------
grant usage on schema private to authenticated;   -- needed so policies can call private helpers
revoke all on all tables in schema private from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on public.profiles, public.friendships, public.rooms, public.room_members, public.room_invites,
                public.game_sessions, public.scores to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.username_available(text), public.claim_username(text, text), public.set_avatar(text), public.touch_presence(),
  public.search_users(text), public.send_friend_request(text), public.respond_friend_request(bigint, boolean),
  public.remove_friend(uuid), public.block_user(uuid), public.my_friends(),
  public.create_room(text, text, int, int), public.join_room(text), public.leave_room(uuid),
  public.invite_to_room(uuid, uuid), public.decline_invite(bigint), public.my_invites(),
  public.update_room(uuid, text, text, text, int), public.room_state(uuid),
  public.start_game(text, uuid), public.submit_score(uuid, int, int, int, real, int),
  public.leaderboard(text, text, int), public.report_user(uuid, text), public.delete_my_account()
  to authenticated;
-- Guests can look at the global leaderboard.
grant execute on function public.leaderboard(text, text, int) to anon;
