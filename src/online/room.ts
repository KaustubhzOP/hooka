/**
 * An online room: private Supabase Realtime channel `room:<id>` (only members
 * can join, enforced by RLS on realtime.messages), presence for who's here,
 * broadcast for match events and WebRTC signalling.
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, api, type RoomState } from '../backend/supabase';
import { reduce, initialMatch, authority, type MatchState, type MatchEvent, type Challenge, type MatchMode } from './match';
import { Mesh, type Signal } from './rtc';
import type { RunStats } from '../game';

export interface RoomHooks {
  changed(): void;                                    // re-render
  toast(text: string): void;
  remoteStream(user: string, stream: MediaStream | null): void;
  matchEvent(e: MatchEvent, before: MatchState, after: MatchState): void;
}

interface PresenceMeta { user_id: string; seat: number; username: string; inCall: boolean }

export class RoomClient {
  state: RoomState | null = null;
  match: MatchState = initialMatch();
  present = new Map<string, PresenceMeta>();
  remoteStats = new Map<string, RunStats>();
  mesh: Mesh | null = null;
  private channel: RealtimeChannel | null = null;
  private absentSince = new Map<string, number>();
  private inCall = false;
  private closed = false;

  constructor(public readonly uid: string, private hooks: RoomHooks) {}

  get id(): string | null { return this.state?.id ?? null; }
  get isAuthority(): boolean {
    const here = [...this.present.values()];
    return authority(here.length ? here : (this.state?.members ?? [])) === this.uid;
  }
  get members() { return this.state?.members ?? []; }
  name(user: string): string { return this.members.find(m => m.user_id === user)?.username ?? this.present.get(user)?.username ?? 'player'; }

  async enter(roomId: string): Promise<void> {
    if (!supabase) throw new Error('offline');
    this.state = await api.roomState(roomId);
    await supabase.realtime.setAuth();       // private channel: send our JWT
    const ch = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { key: this.uid }, broadcast: { self: false } } });
    this.channel = ch;

    ch.on('presence', { event: 'sync' }, () => this.onPresence());
    ch.on('broadcast', { event: 'match' }, ({ payload }) => this.applyMatch(payload as MatchEvent));
    ch.on('broadcast', { event: 'sync' }, ({ payload }) => this.onSync(payload as { from: string; match: MatchState }));
    ch.on('broadcast', { event: 'room' }, () => void this.refresh());
    ch.on('broadcast', { event: 'rtc' }, ({ payload }) => { void this.mesh?.handle(payload as Signal); });
    ch.on('broadcast', { event: 'react' }, ({ payload }) => this.hooks.toast(`${this.name((payload as { from: string }).from)}: ${(payload as { emoji: string }).emoji}`));

    await new Promise<void>((resolve, reject) => {
      ch.subscribe(status => {
        if (status === 'SUBSCRIBED') resolve();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error('Could not connect to the room channel'));
      });
    });
    await this.track();
    this.broadcast('room', {});
    this.hooks.changed();
  }

  async refresh(): Promise<void> {
    if (!this.state || this.closed) return;
    try { this.state = await api.roomState(this.state.id); } catch { /* kicked / room gone */ }
    this.hooks.changed();
  }

  // ---------------------------------------------------------------- host actions
  async configure(patch: { mode?: MatchMode; challenge?: Challenge; rounds?: number }): Promise<void> {
    if (!this.state) return;
    await api.updateRoom(this.state.id, patch);
    await this.refresh();
    this.broadcast('room', {});
  }

  async start(): Promise<void> {
    const s = this.state;
    if (!s || !this.isAuthority) return;
    const order = [...this.present.values()].sort((a, b) => a.seat - b.seat).map(p => p.user_id);
    if (order.length < 2) throw new Error('need_two_players');
    if (s.host_id === this.uid) await api.updateRoom(s.id, { status: 'playing' }).catch(() => {});
    this.emit({ type: 'start', mode: s.mode, challenge: s.challenge, rounds: s.rounds, order, at: Date.now() });
  }

  async backToLobby(): Promise<void> {
    if (!this.state || !this.isAuthority) return;
    if (this.state.host_id === this.uid) await api.updateRoom(this.state.id, { status: 'lobby' }).catch(() => {});
    this.emit({ type: 'reset' });
    this.broadcast('room', {});
  }

  // ----------------------------------------------------------------- player actions
  sendStats(run: RunStats): void { this.emit({ type: 'stats', user: this.uid, run }); }
  turnDone(): void { this.emit({ type: 'turnDone', user: this.uid }); }
  react(emoji: string): void { this.broadcast('react', { from: this.uid, emoji }); this.hooks.toast(`You: ${emoji}`); }

  /** Called every frame-ish by the app: the authority ends live games and skips absent players. */
  tick(now: number): void {
    const m = this.match;
    if (!this.isAuthority || m.phase !== 'playing') return;
    if (m.mode === 'live' && Date.now() >= m.endsAt) { this.emit({ type: 'end' }); return; }
    for (const u of m.order) {
      if (m.left.includes(u)) continue;
      if (this.present.has(u)) { this.absentSince.delete(u); continue; }
      const since = this.absentSince.get(u) ?? now;
      this.absentSince.set(u, since);
      if (now - since > 12000) this.emit({ type: 'leave', user: u });
    }
  }

  // ----------------------------------------------------------------------- call
  async joinCall(local: MediaStream): Promise<void> {
    this.mesh?.close();
    const mesh = new Mesh(this.uid, s => this.broadcast('rtc', s), local);
    mesh.onStream = (u, st) => this.hooks.remoteStream(u, st);
    this.mesh = mesh;
    this.inCall = true;
    await this.track();
    this.syncPeers();
  }

  leaveCall(): void {
    this.mesh?.close();
    this.mesh = null;
    this.inCall = false;
    void this.track();
  }

  get callActive(): boolean { return this.inCall; }

  async leave(): Promise<void> {
    this.closed = true;
    const id = this.state?.id;
    this.leaveCall();
    if (this.match.phase === 'playing') this.emit({ type: 'leave', user: this.uid });
    if (this.channel) { await this.channel.untrack().catch(() => {}); await supabase?.removeChannel(this.channel); }
    this.channel = null;
    if (id) await api.leaveRoom(id).catch(() => {});
    if (id) this.broadcast('room', {});
  }

  // -------------------------------------------------------------------- internals
  private emit(e: MatchEvent) {
    this.broadcast('match', e);
    this.applyMatch(e);
  }

  /** Events come only from room members (the channel is members-only); turn rules are enforced by reduce(). */
  private applyMatch(e: MatchEvent) {
    if (e.type === 'stats' && e.user !== this.uid) this.remoteStats.set(e.user, e.run);
    const before = this.match;
    const after = reduce(before, e);
    if (after === before) return;
    this.match = after;
    this.hooks.matchEvent(e, before, after);
    this.hooks.changed();
  }

  private onSync(p: { from: string; match: MatchState }) {
    // a (re)joining player catches up from the authority
    const here = [...this.present.values()];
    if (authority(here) !== p.from || p.from === this.uid) return;
    if (this.match.phase === 'playing' && p.match.startedAt === this.match.startedAt) return;
    this.match = p.match;
    this.hooks.changed();
  }

  private onPresence() {
    if (!this.channel) return;
    const st = this.channel.presenceState<PresenceMeta>();
    const before = new Set(this.present.keys());
    this.present.clear();
    for (const [key, metas] of Object.entries(st)) if (metas[0]) this.present.set(key, metas[0]);
    const joined = [...this.present.keys()].filter(k => !before.has(k));
    const left = [...before].filter(k => !this.present.has(k));
    if (joined.some(u => !this.members.some(m => m.user_id === u))) void this.refresh();
    for (const u of joined) if (u !== this.uid && before.size) this.hooks.toast(`${this.present.get(u)?.username ?? 'Someone'} joined`);
    for (const u of left) if (u !== this.uid) this.hooks.toast(`${this.name(u)} left`);
    // the authority brings newcomers up to date
    if (joined.length && this.isAuthority && this.match.phase !== 'lobby') this.broadcast('sync', { from: this.uid, match: this.match });
    this.syncPeers();
    this.hooks.changed();
  }

  private syncPeers() {
    if (!this.mesh) return;
    const peers = [...this.present.values()].filter(p => p.inCall && p.user_id !== this.uid).map(p => p.user_id);
    this.mesh.sync(peers);
  }

  private async track() {
    if (!this.channel) return;
    const me = this.members.find(m => m.user_id === this.uid);
    await this.channel.track({ user_id: this.uid, seat: me?.seat ?? 9, username: me?.username ?? '', inCall: this.inCall } satisfies PresenceMeta);
  }

  private broadcast(event: string, payload: unknown) {
    void this.channel?.send({ type: 'broadcast', event, payload });
  }
}
