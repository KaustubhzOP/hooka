/**
 * Supabase client + typed wrappers for the database functions (see supabase/migrations).
 * Auth is Supabase Auth: the client keeps a JWT access token (auto-refreshed) and
 * sends it with every request; Postgres checks it through row-level security.
 * Only the public publishable key lives in the browser.
 */
import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const backendEnabled = !!(URL && KEY);

export const supabase: SupabaseClient | null = backendEnabled
  ? createClient(URL!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })
  : null;

export interface Profile { id: string; username: string; avatar: string; created_at: string; username_changed_at: string; last_seen: string }
export interface FriendRow { request_id: number; user_id: string; username: string; avatar: string; status: 'pending' | 'accepted' | 'blocked'; direction: 'incoming' | 'outgoing'; last_seen: string | null }
export interface SearchRow { id: string; username: string; avatar: string; relation: 'none' | 'friend' | 'outgoing' | 'incoming' | 'blocked' }
export interface LeaderRow { rank: number; user_id: string; username: string; avatar: string; best_score: number; best_combo: number; longest_hold: number; games: number; is_me: boolean }
export interface InviteRow { invite_id: number; room_id: string; code: string; from_username: string; from_avatar: string; mode: string; challenge: string; players: number; max_players: number; created_at: string }
export interface RoomMember { user_id: string; username: string; avatar: string; seat: number }
export interface RoomState { id: string; code: string; host_id: string; mode: 'pass' | 'live'; challenge: 'score' | 'rings' | 'hold' | 'tricks'; rounds: number; max_players: number; status: 'lobby' | 'playing' | 'finished'; members: RoomMember[] }

/** Friendly text for the error codes raised by the database functions. */
const MESSAGES: Record<string, string> = {
  not_authenticated: 'Please sign in first.',
  username_required: 'Pick a username first.',
  username_invalid: 'Usernames are 3–20 characters: letters, numbers and _ (not at the start or end, no double __).',
  username_reserved: 'That username is reserved. Try another.',
  username_inappropriate: 'Please pick a different username.',
  username_taken: 'That username is taken.',
  username_change_too_soon: 'You can change your username once a week.',
  avatar_invalid: 'Pick an avatar emoji.',
  rate_limited: 'Slow down a little and try again in a while.',
  user_not_found: 'No player with that username.',
  cannot_friend_self: 'That’s you!',
  request_not_found: 'That request no longer exists.',
  cannot_block_self: 'You can’t block yourself.',
  room_not_found: 'Room not found (or it has ended).',
  room_full: 'That room is full.',
  room_already_started: 'That game has already started.',
  not_room_member: 'You’re not in that room.',
  not_room_host: 'Only the host can do that.',
  need_two_players: 'You need at least 2 players to start.',
  not_friends: 'You can only invite friends.',
  implausible_score: 'That score didn’t pass the server checks, so it wasn’t saved.',
  already_submitted: 'Score already saved.',
  session_not_found: 'Game session not found.',
  session_expired: 'That game session expired.',
  reason_invalid: 'Please describe the problem (3–500 characters).',
  cannot_report_self: 'You can’t report yourself.'
};

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const msg = (e as { message?: string })?.message ?? String(e);
  return MESSAGES[msg] ?? msg;
}

function client(): SupabaseClient {
  if (!supabase) throw new ApiError('offline', 'Online features are not configured.');
  return supabase;
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client().rpc(fn, args);
  if (error) throw new ApiError(error.message, MESSAGES[error.message] ?? error.message);
  return data as T;
}

/**
 * Fire-and-forget RPC that survives the page closing (fetch keepalive), used to
 * save the last run and leave rooms when the tab is closed.
 */
export async function rpcKeepalive(fn: string, args: Record<string, unknown>): Promise<void> {
  if (!supabase || !URL || !KEY) return;
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) return;
  try {
    await fetch(`${URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', keepalive: true,
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
  } catch { /* best effort */ }
}

// --------------------------------------------------------------------- auth
export const auth = {
  async session(): Promise<Session | null> {
    if (!supabase) return null;
    return (await supabase.auth.getSession()).data.session;
  },
  onChange(cb: (event: string, session: Session | null) => void) {
    return supabase?.auth.onAuthStateChange((event, session) => cb(event, session));
  },
  async google() {
    const { error } = await client().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) throw error;
  },
  async signUp(email: string, password: string) {
    const { data, error } = await client().auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    return data;
  },
  async signIn(email: string, password: string) {
    const { error } = await client().auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async resetPassword(email: string) {
    const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) throw error;
  },
  async updatePassword(password: string) {
    const { error } = await client().auth.updateUser({ password });
    if (error) throw error;
  },
  async signOut() { await client().auth.signOut(); },
  async user(): Promise<User | null> { return (await client().auth.getUser()).data.user; }
};

// ------------------------------------------------------------------ profile
export const api = {
  async myProfile(uid: string): Promise<Profile | null> {
    const { data, error } = await client().from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) throw error;
    return data as Profile | null;
  },
  usernameAvailable: (name: string) => rpc<boolean>('username_available', { p_username: name }),
  claimUsername: (name: string, avatar?: string) => rpc<Profile>('claim_username', { p_username: name, p_avatar: avatar ?? null }),
  setAvatar: (avatar: string) => rpc<void>('set_avatar', { p_avatar: avatar }),
  touch: () => rpc<void>('touch_presence'),
  deleteAccount: () => rpc<void>('delete_my_account'),

  // friends
  searchUsers: (q: string) => rpc<SearchRow[]>('search_users', { p_query: q }),
  sendFriendRequest: (username: string) => rpc<'requested' | 'already_friends' | 'already_requested' | 'accepted'>('send_friend_request', { p_username: username }),
  respondFriend: (id: number, accept: boolean) => rpc<void>('respond_friend_request', { p_request_id: id, p_accept: accept }),
  removeFriend: (userId: string) => rpc<void>('remove_friend', { p_user_id: userId }),
  blockUser: (userId: string) => rpc<void>('block_user', { p_user_id: userId }),
  reportUser: (userId: string, reason: string) => rpc<void>('report_user', { p_user_id: userId, p_reason: reason }),
  myFriends: () => rpc<FriendRow[]>('my_friends'),

  // scores
  startGame: (mode: 'solo' | 'online', room?: string) => rpc<string>('start_game', { p_mode: mode, p_room: room ?? null }),
  submitScore: (session: string, s: { score: number; rings: number; bestCombo: number; longestHold: number; hits: number }) =>
    rpc<{ saved: boolean; best?: number; rank?: number; personal_best?: boolean }>('submit_score', {
      p_session: session, p_score: Math.round(s.score), p_rings: s.rings, p_best_combo: s.bestCombo,
      p_longest_hold: Math.round(s.longestHold * 10) / 10, p_hits: s.hits
    }),
  leaderboard: (period: 'all' | 'week', scope: 'global' | 'friends', limit = 50) =>
    rpc<LeaderRow[]>('leaderboard', { p_period: period, p_scope: scope, p_limit: limit }),

  // rooms
  createRoom: (mode: string, challenge: string, rounds: number, maxPlayers: number) =>
    rpc<{ id: string; code: string }[]>('create_room', { p_mode: mode, p_challenge: challenge, p_rounds: rounds, p_max_players: maxPlayers }).then(r => r[0]),
  joinRoom: (code: string) => rpc<string>('join_room', { p_code: code }),
  leaveRoom: (room: string) => rpc<void>('leave_room', { p_room: room }),
  inviteToRoom: (room: string, userId: string) => rpc<void>('invite_to_room', { p_room: room, p_user_id: userId }),
  declineInvite: (id: number) => rpc<void>('decline_invite', { p_invite_id: id }),
  myInvites: () => rpc<InviteRow[]>('my_invites'),
  updateRoom: (room: string, patch: { status?: string; mode?: string; challenge?: string; rounds?: number }) =>
    rpc<void>('update_room', { p_room: room, p_status: patch.status ?? null, p_mode: patch.mode ?? null, p_challenge: patch.challenge ?? null, p_rounds: patch.rounds ?? null }),
  roomState: (room: string) => rpc<RoomState>('room_state', { p_room: room })
};
