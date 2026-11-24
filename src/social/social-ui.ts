/** Leaderboard and friends screens. */
import { api, friendlyError, type FriendRow, type LeaderRow, type SearchRow } from '../backend/supabase';
import type { AccountStore } from './account';
import { h, openModal, status, debounce, timeAgo } from './modal';
import { showAuth, showUsername } from './account-ui';

export function showLeaderboard(account: AccountStore): void {
  const m = openModal('🏆 Leaderboard', { wide: true });
  let period: 'all' | 'week' = 'week', scope: 'global' | 'friends' = 'global';
  const table = h('div', { class: 'board' });
  const seg = (opts: [string, string][], get: () => string, set: (v: string) => void) => {
    const el = h('div', { class: 'seg small' });
    const draw = () => el.replaceChildren(...opts.map(([v, label]) => h('button', { class: get() === v ? 'sel' : '', onclick: () => { set(v); draw(); void load(); } }, label)));
    draw();
    return el;
  };
  const load = async () => {
    table.replaceChildren(h('p', { class: 'dim' }, 'Loading…'));
    try {
      const rows = await api.leaderboard(period, scope, 50);
      if (!rows.length) {
        table.replaceChildren(h('p', { class: 'dim' }, scope === 'friends' ? 'No scores from you or your friends yet. Play a run and save it!' : 'No scores yet. Be the first!'));
        return;
      }
      table.replaceChildren(
        h('div', { class: 'brow head' }, h('span', {}, '#'), h('span', {}, 'Player'), h('span', {}, 'Best'), h('span', { class: 'hideSm' }, '⭕ combo'), h('span', { class: 'hideSm' }, 'Hold'), h('span', { class: 'hideSm' }, 'Runs')),
        ...rows.map((r: LeaderRow) => h('div', { class: 'brow' + (r.is_me ? ' me' : '') + (r.rank <= 3 ? ' top' : '') },
          h('span', {}, r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : String(r.rank)),
          h('span', { class: 'who' }, `${r.avatar} ${r.username}`),
          h('b', {}, String(r.best_score)),
          h('span', { class: 'hideSm' }, String(r.best_combo)),
          h('span', { class: 'hideSm' }, `${Number(r.longest_hold).toFixed(1)}s`),
          h('span', { class: 'hideSm' }, String(r.games)))));
    } catch (e) { table.replaceChildren(h('p', { class: 'formStatus err' }, friendlyError(e))); }
  };
  m.body.append(
    h('div', { class: 'row' },
      seg([['week', 'This week'], ['all', 'All time']], () => period, v => { period = v as typeof period; }),
      account.canPlayOnline ? seg([['global', 'Everyone'], ['friends', 'Friends']], () => scope, v => { scope = v as typeof scope; }) : ''),
    table,
    !account.signedIn ? h('p', { class: 'hintTxt' }, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); showAuth(account, 'signin', 'Sign in to save your scores to the leaderboard.'); } }, 'Sign in'), ' to get on the board.') : '',
    h('p', { class: 'fine' }, 'Your best run counts. Scores are checked by the server before they are saved.'));
  void load();
}

export interface FriendsOptions {
  /** When in a room: show “Invite” buttons. */
  invite?: (userId: string, username: string) => Promise<void>;
  onChange?: () => void;
}

export function showFriends(account: AccountStore, opts: FriendsOptions = {}): void {
  if (!account.signedIn) { showAuth(account, 'signin', 'Sign in to add friends.'); return; }
  if (!account.profile) { showUsername(account, true); return; }
  const m = openModal('👥 Friends', { wide: true });
  const st = status();
  const search = h('input', { type: 'search', placeholder: 'Find players by username…', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
  const results = h('div', { class: 'list' });
  const lists = h('div', {});

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) st.set(ok, 'ok'); await refresh(); void runSearch(); opts.onChange?.(); }
    catch (e) { st.set(friendlyError(e), 'err'); }
  };

  const userRow = (avatar: string, name: string, sub: string, ...buttons: (HTMLElement | null)[]) =>
    h('div', { class: 'urow' }, h('span', { class: 'av' }, avatar), h('div', { class: 'uname' }, h('b', {}, name), h('small', {}, sub)), h('div', { class: 'uact' }, ...buttons));

  const runSearch = async () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) { results.replaceChildren(); return; }
    try {
      const rows = await api.searchUsers(q);
      results.replaceChildren(...(rows.length ? rows.map((r: SearchRow) => userRow(r.avatar, r.username,
        { none: '', friend: 'friend', outgoing: 'request sent', incoming: 'wants to be friends', blocked: 'blocked' }[r.relation],
        r.relation === 'none' ? h('button', { class: 'primary', onclick: () => act(() => api.sendFriendRequest(r.username), `Friend request sent to ${r.username}`) }, '➕ Add') : null,
        r.relation === 'incoming' ? h('button', { class: 'primary', onclick: () => act(() => api.sendFriendRequest(r.username), `You and ${r.username} are now friends`) }, 'Accept') : null,
        r.relation === 'friend' && opts.invite ? h('button', { onclick: () => act(() => opts.invite!(r.id, r.username), `Invited ${r.username}`) }, 'Invite') : null
      )) : [h('p', { class: 'dim' }, 'No players found.')]));
    } catch (e) { st.set(friendlyError(e), 'err'); }
  };
  search.addEventListener('input', debounce(runSearch, 300));

  const refresh = async () => {
    let rows: FriendRow[] = [];
    try { rows = await api.myFriends(); } catch (e) { st.set(friendlyError(e), 'err'); return; }
    const incoming = rows.filter(r => r.status === 'pending' && r.direction === 'incoming');
    const outgoing = rows.filter(r => r.status === 'pending' && r.direction === 'outgoing');
    const friends = rows.filter(r => r.status === 'accepted')
      .sort((a, b) => (timeAgo(b.last_seen) === 'online' ? 1 : 0) - (timeAgo(a.last_seen) === 'online' ? 1 : 0));
    const blocked = rows.filter(r => r.status === 'blocked');
    const menu = (r: FriendRow) => {
      const sel = h('select', { class: 'more', 'aria-label': 'More', onchange: async () => {
        const v = sel.value; sel.value = '';
        if (v === 'remove' && confirm(`Remove ${r.username} from your friends?`)) await act(() => api.removeFriend(r.user_id), 'Removed');
        if (v === 'block' && confirm(`Block ${r.username}? They won't be able to find you or join your rooms.`)) await act(() => api.blockUser(r.user_id), 'Blocked');
        if (v === 'report') {
          const reason = prompt(`What did ${r.username} do? (sent privately to the moderators)`);
          if (reason) await act(() => api.reportUser(r.user_id, reason), 'Report sent. Thank you.');
        }
      } }, h('option', { value: '' }, '⋯'), h('option', { value: 'remove' }, 'Remove friend'), h('option', { value: 'block' }, 'Block'), h('option', { value: 'report' }, 'Report'));
      return sel;
    };
    lists.replaceChildren(
      incoming.length ? h('h3', {}, `Requests (${incoming.length})`) : '',
      ...incoming.map(r => userRow(r.avatar, r.username, 'wants to be friends',
        h('button', { class: 'primary', onclick: () => act(() => api.respondFriend(r.request_id, true), `You and ${r.username} are now friends`) }, 'Accept'),
        h('button', { onclick: () => act(() => api.respondFriend(r.request_id, false)) }, 'Decline'))),
      h('h3', {}, `Friends (${friends.length})`),
      ...(friends.length ? friends.map(r => userRow(r.avatar, r.username, timeAgo(r.last_seen) === 'online' ? '🟢 online' : timeAgo(r.last_seen),
        opts.invite ? h('button', { class: 'primary', onclick: () => act(() => opts.invite!(r.user_id, r.username), `Invited ${r.username}`) }, 'Invite') : null,
        menu(r))) : [h('p', { class: 'dim' }, 'No friends yet: search for a username above.')]),
      outgoing.length ? h('h3', {}, 'Sent requests') : '',
      ...outgoing.map(r => userRow(r.avatar, r.username, 'pending', h('button', { onclick: () => act(() => api.removeFriend(r.user_id)) }, 'Cancel'))),
      blocked.length ? h('h3', {}, 'Blocked') : '',
      ...blocked.map(r => userRow(r.avatar, r.username, 'blocked', h('button', { onclick: () => act(() => api.removeFriend(r.user_id), 'Unblocked') }, 'Unblock'))));
  };

  m.body.append(
    h('p', { class: 'hintTxt' }, `You are ${account.profile.avatar} @${account.profile.username}`),
    search, results, st.el, lists);
  void refresh();
}
