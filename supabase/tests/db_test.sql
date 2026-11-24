-- Database tests for the Virtual Hookah backend. Run with supabase/tests/run.sh.
-- Each block acts as a user (JWT `sub`) with the `authenticated` role, like the API does.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

create or replace function public.t_as(p_user uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false); end $$;
grant execute on function public.t_as(uuid) to authenticated, anon;

-- expects `p_sql` to fail with an exception whose message is `p_msg`
create or replace function public.t_fails(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm <> p_msg then raise exception 'expected error "%", got "%" for: %', p_msg, sqlerrm, p_sql; end if;
    return;
  end;
  raise exception 'expected error "%" but it succeeded: %', p_msg, p_sql;
end $$;
grant execute on function public.t_fails(text, text) to authenticated, anon;

create or replace function public.t_eq(a anyelement, b anyelement, what text) returns void language plpgsql as $$
begin if a is distinct from b then raise exception '% : expected %, got %', what, b, a; end if; end $$;
grant execute on function public.t_eq(anyelement, anyelement, text) to authenticated, anon;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@x.test'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@x.test'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@x.test'),
  ('00000000-0000-0000-0000-00000000000d', 'dave@x.test'),
  ('00000000-0000-0000-0000-00000000000e', 'eve@x.test');

\echo '-- usernames'
set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000a');
select t_fails($$select public.search_users('bo')$$, 'username_required');
select t_fails($$select public.claim_username('ab')$$, 'username_invalid');
select t_fails($$select public.claim_username('has space')$$, 'username_invalid');
select t_fails($$select public.claim_username('admin')$$, 'username_reserved');
select t_fails($$select public.claim_username('xxfuckxx')$$, 'username_inappropriate');
select t_eq(public.username_available('Alice'), true, 'alice available');
select t_eq((public.claim_username('Alice', '😎')).username, 'alice', 'stored lower-case');
select t_as('00000000-0000-0000-0000-00000000000b');
select t_eq(public.username_available('ALICE'), false, 'case-insensitive uniqueness');
select t_fails($$select public.claim_username('alice')$$, 'username_taken');
select public.claim_username('bob');
select t_as('00000000-0000-0000-0000-00000000000c'); select public.claim_username('carol');
select t_as('00000000-0000-0000-0000-00000000000d'); select public.claim_username('dave');
select t_as('00000000-0000-0000-0000-00000000000e'); select public.claim_username('eve');
select t_as('00000000-0000-0000-0000-00000000000d');
select t_fails($$select public.claim_username('dave2')$$, 'username_change_too_soon');

\echo '-- no direct writes'
select t_fails($$insert into public.profiles (id, username) values ('00000000-0000-0000-0000-00000000000d', 'hack')$$, 'permission denied for table profiles');
select t_fails($$update public.profiles set username = 'hacked'$$, 'permission denied for table profiles');
select t_fails($$insert into public.scores (user_id, session_id, mode, score, rings, best_combo, longest_hold, hits) values (auth.uid(), gen_random_uuid(), 'solo', 99999, 0, 0, 0, 1)$$, 'permission denied for table scores');
select t_fails($$select * from private.rate_limits$$, 'permission denied for table rate_limits');

\echo '-- friends'
select t_as('00000000-0000-0000-0000-00000000000a');
select t_eq((select count(*) from public.search_users('b'))::int, 0, 'search needs 2 chars');
select t_eq((select relation from public.search_users('bo')), 'none', 'bob found');
select t_eq(public.send_friend_request('bob'), 'requested', 'request sent');
select t_eq(public.send_friend_request('bob'), 'already_requested', 'no duplicate');
select t_fails($$select public.send_friend_request('alice')$$, 'cannot_friend_self');
select t_fails($$select public.send_friend_request('nobody')$$, 'user_not_found');
select t_as('00000000-0000-0000-0000-00000000000b');
select t_eq((select direction from public.my_friends() where username = 'alice'), 'incoming', 'bob sees incoming');
select public.respond_friend_request((select request_id from public.my_friends() where username = 'alice'), true);
select t_eq((select status from public.my_friends() where username = 'alice'), 'accepted', 'accepted');
select t_eq(public.send_friend_request('carol'), 'requested', 'bob → carol');
select t_as('00000000-0000-0000-0000-00000000000c');
select t_eq(public.send_friend_request('bob'), 'accepted', 'mutual request auto-accepts');
-- carol cannot see alice-bob friendship
select t_eq((select count(*) from public.friendships)::int, 1, 'carol only sees her own friendships');
-- dave blocks carol: carol can no longer find dave, and can't see the block
select t_as('00000000-0000-0000-0000-00000000000d');
select public.block_user('00000000-0000-0000-0000-00000000000c');
select t_as('00000000-0000-0000-0000-00000000000c');
select t_eq((select count(*) from public.search_users('da'))::int, 0, 'blocked user hidden');
select t_fails($$select public.send_friend_request('dave')$$, 'user_not_found');
select t_eq((select count(*) from public.friendships where status = 'blocked')::int, 0, 'block invisible to blocked');

\echo '-- rooms'
select t_as('00000000-0000-0000-0000-00000000000a');
create temp table t_room as select * from public.create_room('pass', 'rings', 3, 3);
grant select on t_room to authenticated;
select t_eq((select code ~ '^[A-Z2-9]{8}$' from t_room), true, 'room code format');
select t_fails($$select public.create_room('pass', 'rings', 3, 6)$$, 'invalid_max_players');
select public.invite_to_room((select id from t_room), '00000000-0000-0000-0000-00000000000b');
select t_fails($$select public.invite_to_room((select id from t_room), '00000000-0000-0000-0000-00000000000c')$$, 'not_friends');
select t_fails($$select public.update_room((select id from t_room), 'playing')$$, 'need_two_players');
select t_as('00000000-0000-0000-0000-00000000000b');
select t_eq((select count(*) from public.my_invites())::int, 1, 'bob invited');
select t_eq((select count(*) from public.rooms)::int, 1, 'invitee can see the room');
select public.join_room((select code from public.my_invites() limit 1));
select t_eq((select count(*) from public.my_invites())::int, 0, 'invite consumed');
select t_eq(jsonb_array_length(public.room_state((select id from t_room)) -> 'members'), 2, 'two members');
select t_fails($$select public.update_room((select id from t_room), 'playing')$$, 'not_room_host');
select t_as('00000000-0000-0000-0000-00000000000c');
select t_eq((select count(*) from public.rooms)::int, 0, 'outsider cannot see the room');
select t_fails($$select public.room_state((select id from t_room))$$, 'not_room_member');
select public.join_room((select code from t_room));                 -- carol joins by code
select t_as('00000000-0000-0000-0000-00000000000e');
select t_fails($$select public.join_room((select code from t_room))$$, 'room_full');
select t_as('00000000-0000-0000-0000-00000000000d');
select t_fails($$select public.join_room((select code from t_room))$$, 'room_not_found');   -- blocked by a member
select t_fails($$select public.join_room('ZZZZZZZZ')$$, 'room_not_found');

\echo '-- realtime channel authorization'
select t_as('00000000-0000-0000-0000-00000000000b');
select set_config('realtime.topic', 'room:' || (select id from t_room), false);
insert into realtime.messages (topic, event, payload) values (realtime.topic(), 'hello', '{}');
select t_eq((select count(*) from realtime.messages)::int, 1, 'member reads room channel');
select t_as('00000000-0000-0000-0000-00000000000d');
select t_eq((select count(*) from realtime.messages)::int, 0, 'outsider cannot read room channel');
select t_fails($$insert into realtime.messages (topic, event, payload) values (realtime.topic(), 'x', '{}')$$,
               'new row violates row-level security policy for table "messages"');
select set_config('realtime.topic', 'user:00000000-0000-0000-0000-00000000000d', false);
insert into realtime.messages (topic, event, payload) values (realtime.topic(), 'me', '{}');
select set_config('realtime.topic', 'user:00000000-0000-0000-0000-00000000000a', false);
select t_fails($$insert into realtime.messages (topic, event, payload) values (realtime.topic(), 'x', '{}')$$,
               'new row violates row-level security policy for table "messages"');

\echo '-- host leaves → host passes on; room starts'
select t_as('00000000-0000-0000-0000-00000000000a');
select public.leave_room((select id from t_room));
select t_as('00000000-0000-0000-0000-00000000000b');
select t_eq((public.room_state((select id from t_room)) ->> 'host_id')::uuid, '00000000-0000-0000-0000-00000000000b'::uuid, 'bob is host');
select public.update_room((select id from t_room), 'playing');
select t_eq(public.room_state((select id from t_room)) ->> 'status', 'playing', 'room playing');

\echo '-- scores and anti-cheat'
reset role;
-- pretend Bob's session started 10 minutes ago (sessions can only be created through start_game)
set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000b');
create temp table t_s as select public.start_game('online', (select id from t_room)) as id;
grant select on t_s to authenticated;
reset role;
update public.game_sessions set started_at = now() - interval '10 minutes';
set role authenticated;
select t_fails($$select public.submit_score((select id from t_s), 99999, 0, 0, 1, 2)$$, 'implausible_score');   -- too many points
select t_fails($$select public.submit_score((select id from t_s), 100, 0, 0, 1, 1000)$$, 'implausible_score');  -- too many hits for 10 min
select t_fails($$select public.submit_score((select id from t_s), 100, 3, 5, 1, 2)$$, 'implausible_score');    -- combo > rings
select t_eq((public.submit_score((select id from t_s), 420, 6, 4, 5.5, 8) ->> 'saved')::boolean, true, 'valid score saved');
select t_fails($$select public.submit_score((select id from t_s), 420, 6, 4, 5.5, 8)$$, 'already_submitted');
select t_as('00000000-0000-0000-0000-00000000000c');
select t_fails($$select public.submit_score((select id from t_s), 1, 0, 0, 1, 1)$$, 'session_not_found');    -- not her session
select t_fails($$select public.start_game('online', '00000000-0000-0000-0000-000000000099')$$, 'not_room_member');
create temp table t_s2 as select public.start_game('solo') as id;
grant select on t_s2 to authenticated;
reset role;
update public.game_sessions set started_at = now() - interval '5 minutes' where id = (select id from t_s2);
set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000c');
select public.submit_score((select id from t_s2), 900, 10, 6, 6, 9);

\echo '-- leaderboard'
select t_eq((select username from public.leaderboard('all', 'global', 10) where rank = 1), 'carol', 'carol first');
select t_eq((select rank from public.leaderboard('week', 'global', 10) where username = 'bob'), 2::bigint, 'bob second this week');
select t_as('00000000-0000-0000-0000-00000000000a');
select t_eq((select count(*) from public.leaderboard('all', 'friends', 10))::int, 1, 'alice sees only friend bob');
select t_as('00000000-0000-0000-0000-00000000000d');
select t_eq((select count(*) from public.leaderboard('all', 'global', 10) where username = 'carol')::int, 0, 'blocked hidden on board');
reset role;
set role anon;
select t_as(null);
select t_eq((select count(*) from public.leaderboard('all', 'global', 10))::int, 2, 'guests see the global board');
select t_fails($$select public.search_users('al')$$, 'permission denied for function search_users');
select t_fails($$select * from public.profiles$$, 'permission denied for table profiles');
reset role;

\echo '-- rate limit'
set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000a');
do $$ begin for i in 1..10 loop perform private.rate_limit('t', 10, 60); end loop; end $$;
select t_fails($$select private.rate_limit('t', 10, 60)$$, 'rate_limited');

\echo '-- reports and account deletion'
select t_fails($$select public.report_user('00000000-0000-0000-0000-00000000000b', 'x')$$, 'reason_invalid');
select public.report_user('00000000-0000-0000-0000-00000000000b', 'spamming invites');
select t_fails($$select * from public.reports$$, 'permission denied for table reports');
select t_as('00000000-0000-0000-0000-00000000000c');
select public.delete_my_account();
reset role;
select t_eq((select count(*) from public.profiles where username = 'carol')::int, 0, 'carol deleted');
select t_eq((select count(*) from public.scores)::int, 1, 'carol scores deleted');

\echo 'ALL DATABASE TESTS PASSED'
