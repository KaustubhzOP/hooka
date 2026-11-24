/**
 * Online play: lobby (create / join / invites), the room panel, the call
 * tiles, and the compositor that sends your stage (camera + smoke + hookah)
 * as your call video.
 */
import { api, friendlyError, type InviteRow } from '../backend/supabase';
import type { AccountStore } from '../social/account';
import { showAuth, showUsername } from '../social/account-ui';
import { showFriends } from '../social/social-ui';
import { h, openModal, status } from '../social/modal';
import { RoomClient } from './room';
import { fetchIceServers } from './rtc';
import { canPlay, activePlayer, standings, metric, CHALLENGE_LABEL, LIVE_ROUND_SECONDS, type MatchState, type MatchEvent, type Challenge, type MatchMode } from './match';
import type { RunStats } from '../game';

export interface OnlineDeps {
  toast(text: string): void;
  log(text: string): void;
  banner(text: string | null, ms?: number): void;
  enteredRoom(): void;
  leftRoom(): void;
  matchStarted(roomId: string): void;
  matchFinished(): void;
  layout(): void;
  /** The raw camera track (sent instead of the composited stage while the tab is hidden). */
  cameraTrack(): MediaStreamTrack | null;
}

export interface Layer { src: CanvasImageSource; mirror?: boolean; blend?: GlobalCompositeOperation; visible?: boolean }

const MODE_LABEL: Record<MatchMode, string> = { pass: '🪈 Pass the hookah (turns)', live: '⚡ Live challenge (all at once)' };
const REACTIONS = ['👏', '🔥', '😂', '😮', '👑', '💨'];

export class OnlineController {
  room: RoomClient | null = null;
  private panel = document.getElementById('roomPanel')!;
  private tiles = document.getElementById('tiles')!;
  private tileEls = new Map<string, HTMLElement>();
  private callCanvas = document.createElement('canvas');
  private callCtx = this.callCanvas.getContext('2d')!;
  private outStream: MediaStream | null = null;
  private mic: MediaStream | null = null;
  private micOn = true;
  private canvasTrack: MediaStreamTrack | null = null;
  private sendingCamera = false;
  private lastComposite = 0;
  private watchdog = 0;
  private onVisibility = () => this.syncVideoSource();
  private camOn = true;
  private lastRender = 0;
  invites: InviteRow[] = [];

  constructor(private account: AccountStore, private deps: OnlineDeps) {}

  get inRoom() { return !!this.room; }
  get uid() { return this.account.uid; }

  /** May this device's player inhale right now? (always true outside a room) */
  canPlay(): boolean {
    if (!this.room || !this.uid) return true;
    return canPlay(this.room.match, this.uid, Date.now());
  }

  /** Text for the hint line while waiting for your turn. */
  waitingText(): string | null {
    const r = this.room;
    if (!r || !this.uid) return null;
    const m = r.match;
    if (m.phase === 'lobby') return r.isAuthority ? 'Invite friends, then press Start in the room panel.' : 'Waiting for the host to start…';
    if (m.phase === 'finished') return 'Game over! See the results in the room panel.';
    if (m.mode === 'live' && Date.now() >= m.endsAt) return 'Time’s up!';
    const holder = activePlayer(m);
    if (holder && holder !== this.uid) return `${r.name(holder)} has the hookah… watch their tile!`;
    return null;
  }

  // ------------------------------------------------------------------ lobby
  openLobby(): void {
    if (!this.account.signedIn) { showAuth(this.account, 'signin', 'Sign in to play online with friends.'); return; }
    if (!this.account.profile) { showUsername(this.account, true); return; }
    if (this.room) { this.deps.toast('You are already in a room: see the room panel.'); return; }
    const m = openModal('🌐 Play online', { wide: true });
    const st = status();
    let mode: MatchMode = 'pass', challenge: Challenge = 'score', rounds = 3, max = 5;
    const sel = <T extends string | number>(opts: [T, string][], get: () => T, set: (v: T) => void) => {
      const el = h('div', { class: 'seg small' });
      const draw = () => el.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', class: get() === v ? 'sel' : '', onclick: () => { set(v); draw(); } }, l)));
      draw(); return el;
    };
    const code = h('input', { type: 'text', placeholder: 'ROOM CODE', maxLength: 8, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, class: 'codeInput' });
    code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z2-9]/g, ''); });
    const invitesBox = h('div', { class: 'list' });
    const drawInvites = async () => {
      try { this.invites = await api.myInvites(); } catch { /* ignore */ }
      invitesBox.replaceChildren(...(this.invites.length ? this.invites.map(i => h('div', { class: 'urow' },
        h('span', { class: 'av' }, i.from_avatar), h('div', { class: 'uname' }, h('b', {}, `${i.from_username} invited you`), h('small', {}, `${i.players}/${i.max_players} players · ${CHALLENGE_LABEL[i.challenge as Challenge] ?? i.challenge}`)),
        h('div', { class: 'uact' },
          h('button', { class: 'primary', onclick: () => void this.join(i.code, m, st) }, 'Join'),
          h('button', { onclick: async () => { await api.declineInvite(i.invite_id).catch(() => {}); void drawInvites(); } }, 'Decline'))))
        : [h('p', { class: 'dim' }, 'No invites right now.')]));
    };

    m.body.append(
      h('div', { class: 'cols' },
        h('section', {},
          h('h3', {}, 'Create a room'),
          h('label', {}, 'Mode'), sel<MatchMode>([['pass', MODE_LABEL.pass], ['live', MODE_LABEL.live]], () => mode, v => { mode = v; }),
          h('label', {}, 'Challenge'), sel<Challenge>([['score', 'Score'], ['rings', 'Rings'], ['hold', 'Hold'], ['tricks', 'Tricks']], () => challenge, v => { challenge = v; }),
          h('label', {}, 'Rounds'), sel<number>([[1, '1'], [2, '2'], [3, '3'], [5, '5']], () => rounds, v => { rounds = v; }),
          h('label', {}, 'Max players'), sel<number>([[2, '2'], [3, '3'], [4, '4'], [5, '5']], () => max, v => { max = v; }),
          h('button', { class: 'primary big', onclick: async () => {
            try { const r = await api.createRoom(mode, challenge, rounds, max); await this.enter(r.id); m.close(); }
            catch (e) { st.set(friendlyError(e), 'err'); }
          } }, 'Create room')),
        h('section', {},
          h('h3', {}, 'Join with a code'),
          h('form', { class: 'row', onsubmit: (e: Event) => { e.preventDefault(); void this.join(code.value, m, st); } }, code, h('button', { class: 'primary', type: 'submit' }, 'Join')),
          h('h3', {}, 'Invites'), invitesBox)),
      st.el,
      h('p', { class: 'fine' }, '🎥 Video calls go straight between your devices and are never recorded or stored.'));
    void drawInvites();
  }

  async join(code: string, modal?: { close(): void }, st?: { set(t: string, k?: 'ok' | 'err' | 'info'): void }): Promise<void> {
    try {
      const id = await api.joinRoom(code);
      await this.enter(id);
      modal?.close();
    } catch (e) {
      if (st) st.set(friendlyError(e), 'err'); else this.deps.toast(friendlyError(e));
    }
  }

  async enter(roomId: string): Promise<void> {
    if (!this.uid) return;
    const room = new RoomClient(this.uid, {
      changed: () => this.render(),
      toast: t => this.deps.toast(t),
      remoteStream: (u, s) => this.setTile(u, s),
      matchEvent: (e, before, after) => this.onMatch(e, before, after)
    });
    this.room = room;
    try { await room.enter(roomId); }
    catch (e) { this.room = null; throw e; }
    this.deps.log(`joined room ${room.state?.code}`);
    this.deps.enteredRoom();
    history.replaceState(null, '', `${location.pathname}?room=${room.state?.code}`);
    this.render();
    this.deps.layout();
  }

  async leave(): Promise<void> {
    const r = this.room;
    if (!r) return;
    this.stopCall();
    await r.leave();
    this.room = null;
    this.tiles.replaceChildren(); this.tileEls.clear();
    history.replaceState(null, '', location.pathname);
    this.render();
    this.deps.leftRoom();
    this.deps.layout();
  }

  // --------------------------------------------------------------- game hooks
  /** The local player's run changed. */
  runUpdated(run: RunStats, hitEnded: boolean): void {
    const r = this.room;
    if (!r || r.match.phase !== 'playing') return;
    r.sendStats(run);
    if (hitEnded && r.match.mode === 'pass' && activePlayer(r.match) === this.uid) r.turnDone();
  }

  tick(now: number): void {
    this.room?.tick(now);
    if (this.room && now - this.lastRender > 500) { this.lastRender = now; this.renderStatus(); }
  }

  private onMatch(e: MatchEvent, before: MatchState, after: MatchState) {
    const r = this.room!;
    if (e.type === 'start') {
      this.deps.matchStarted(r.id!);
      this.deps.banner(after.mode === 'live'
        ? `⚡ Go! ${CHALLENGE_LABEL[after.challenge]} · ${after.rounds * LIVE_ROUND_SECONDS}s`
        : `🪈 ${activePlayer(after) === this.uid ? 'You start' : r.name(activePlayer(after)!) + ' starts'}: ${CHALLENGE_LABEL[after.challenge]}`, 2600);
    }
    if (after.phase === 'playing' && after.mode === 'pass' && activePlayer(after) !== activePlayer(before)) {
      const holder = activePlayer(after)!;
      this.deps.banner(holder === this.uid ? '🪈 Your turn! Pen to your lips…' : `🪈 ${r.name(holder)} has the hookah`, 2000);
    }
    if (before.phase === 'playing' && after.phase === 'finished') {
      const top = standings(after)[0];
      this.deps.banner(top ? `🏆 ${top.user === this.uid ? 'You win' : r.name(top.user) + ' wins'}!` : 'Game over', 3500);
      this.deps.matchFinished();
    }
  }

  // ------------------------------------------------------------------- call
  async startCall(): Promise<void> {
    const r = this.room;
    if (!r) return;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.deps.toast('Microphone blocked: you can still be seen, but not heard.');
      this.mic = null;
    }
    // draw a first frame right away so friends never get an empty (black) canvas
    this.drawPlaceholder(this.callCanvas.width === 300 ? 640 : this.callCanvas.width, this.callCanvas.width === 300 ? 360 : this.callCanvas.height);
    const video = this.callCanvas.captureStream(20);
    this.canvasTrack = video.getVideoTracks()[0] ?? null;
    this.outStream = new MediaStream([...video.getVideoTracks(), ...(this.mic?.getAudioTracks() ?? [])]);
    this.micOn = !!this.mic; this.camOn = true;
    this.sendingCamera = false;
    this.lastComposite = performance.now();
    document.addEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.watchdog);
    this.watchdog = window.setInterval(() => this.syncVideoSource(), 1000);
    const servers = await fetchIceServers();
    await r.joinCall(this.outStream, servers);
    this.deps.log(`joined the call (${r.mesh?.hasRelay ? 'with TURN relay' : 'STUN only: may fail on some mobile networks'})`);
    this.render(); this.deps.layout();
  }

  stopCall(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    clearInterval(this.watchdog);
    this.canvasTrack = null; this.sendingCamera = false;
    this.room?.leaveCall();
    this.mic?.getTracks().forEach(t => t.stop());
    this.outStream?.getVideoTracks().forEach(t => t.stop());
    this.mic = null; this.outStream = null;
    for (const [u] of this.tileEls) this.setTile(u, null);
    this.render(); this.deps.layout();
  }

  get inCall() { return !!this.room?.callActive; }

  /**
   * Browsers stop drawing in hidden / minimised / fully covered tabs, so the composited
   * stage freezes. Then we send the plain camera instead (your face without the smoke),
   * and switch back to the stage as soon as it is drawing again.
   */
  private syncVideoSource() {
    const mesh = this.room?.mesh;
    if (!mesh || !this.canvasTrack) return;
    const stalled = document.hidden || performance.now() - this.lastComposite > 1500;
    const cam = this.deps.cameraTrack();
    const useCamera = stalled && !!cam && cam.readyState === 'live' && this.camOn;
    if (useCamera === this.sendingCamera) return;
    this.sendingCamera = useCamera;
    mesh.replaceLocal(new MediaStream([useCamera ? cam! : this.canvasTrack, ...(this.mic?.getAudioTracks() ?? [])]));
    this.deps.log(useCamera ? 'call: tab not drawing → sending plain camera' : 'call: sending the stage again (camera + smoke)');
  }

  private drawPlaceholder(cw: number, ch: number, text = 'camera not started yet') {
    if (this.callCanvas.width !== cw || this.callCanvas.height !== ch) { this.callCanvas.width = cw; this.callCanvas.height = ch; }
    const g = this.callCtx;
    g.globalCompositeOperation = 'source-over';
    const bg = g.createLinearGradient(0, 0, 0, ch);
    bg.addColorStop(0, '#1b1c26'); bg.addColorStop(1, '#0b0c10');
    g.fillStyle = bg; g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${Math.round(ch * 0.22)}px system-ui`;
    g.fillText(this.account.profile?.avatar ?? '🙂', cw / 2, ch * 0.42);
    g.font = `600 ${Math.round(ch * 0.065)}px system-ui`;
    g.fillText(this.account.profile?.username ?? '', cw / 2, ch * 0.66);
    g.fillStyle = '#8b8ea0';
    g.font = `${Math.round(ch * 0.05)}px system-ui`;
    g.fillText(text, cw / 2, ch * 0.76);
  }

  /** Draw this frame of the stage into the outgoing call video. `cameraReady`: the camera is producing frames. */
  composite(layers: Layer[], W: number, H: number, cameraReady = true): void {
    if (!this.inCall) return;
    this.lastComposite = performance.now();
    if (this.sendingCamera) this.syncVideoSource();
    const cw = 640, ch = Math.round(640 * H / W);
    if (!this.camOn || !cameraReady) {
      this.drawPlaceholder(cw, ch, this.camOn ? 'camera not started yet' : 'camera off');
      if (!this.camOn) return;
      layers = layers.slice(1);                          // still show the hookah and smoke
    }
    if (this.callCanvas.width !== cw || this.callCanvas.height !== ch) { this.callCanvas.width = cw; this.callCanvas.height = ch; }
    const g = this.callCtx;
    g.globalCompositeOperation = 'source-over';
    if (cameraReady) { g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch); }
    for (const l of layers) {
      if (l.visible === false) continue;
      g.save();
      g.globalCompositeOperation = l.blend ?? 'source-over';
      if (l.mirror) { g.translate(cw, 0); g.scale(-1, 1); }
      g.drawImage(l.src, 0, 0, cw, ch);
      g.restore();
    }
  }

  private setTile(user: string, stream: MediaStream | null) {
    let tile = this.tileEls.get(user);
    if (!stream) {
      tile?.remove(); this.tileEls.delete(user);
      this.updateCallLayout();
      return;
    }
    if (!tile) {
      const video = h('video', { autoplay: true, playsInline: true });
      video.setAttribute('playsinline', '');            // iOS Safari needs the attribute, not just the property
      const unmute = h('button', { class: 'unmute', hidden: true, onclick: () => {
        video.muted = false;
        void video.play().then(() => { unmute.hidden = true; }).catch(() => {});
      } }, '🔇 Tap to unmute');
      tile = h('div', { class: 'tile novideo', 'data-user': user }, video, unmute, h('div', { class: 'tileWait' }, 'Connecting video…'), h('div', { class: 'tileLabel' }));
      const t = tile;
      const check = () => t.classList.toggle('novideo', !(video.videoWidth > 0 && video.readyState >= 2));
      for (const ev of ['loadeddata', 'resize', 'playing', 'emptied']) video.addEventListener(ev, check);
      this.tiles.append(tile);
      this.tileEls.set(user, tile);
    }
    const v = tile.querySelector('video')!;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      this.playTile(v, tile.querySelector<HTMLButtonElement>('.unmute')!);
    }
    this.updateCallLayout();
    this.renderTiles();
  }

  /** Phones often refuse to auto-play video with sound: fall back to muted playback plus a tap-to-unmute button. */
  private playTile(v: HTMLVideoElement, unmute: HTMLButtonElement) {
    v.play().catch(() => {
      v.muted = true;
      unmute.hidden = false;
      void v.play().catch(() => { unmute.textContent = '▶️ Tap to play'; });
    });
  }

  /** Show the tiles row as soon as there is a remote video (not only on the next panel render). */
  private updateCallLayout() {
    const on = this.inCall && this.tileEls.size > 0;
    if (document.body.classList.contains('inCall') !== on) {
      document.body.classList.toggle('inCall', on);
      this.deps.layout();
    }
  }

  // ------------------------------------------------------------------ render
  render(): void {
    const r = this.room;
    document.body.classList.toggle('inRoom', !!r);
    this.updateCallLayout();
    this.panel.hidden = !r;
    if (!r || !r.state) { this.panel.replaceChildren(); return; }
    const s = r.state, m = r.match, me = this.uid!;
    const auth = r.isAuthority;
    const link = `${location.origin}${location.pathname}?room=${s.code}`;

    const members = h('div', { class: 'list' }, ...s.members.map(mem => {
      const here = r.present.get(mem.user_id);
      const stats = mem.user_id === me ? null : r.remoteStats.get(mem.user_id);
      const val = m.phase !== 'lobby' ? (m.stats[mem.user_id] ?? stats) : null;
      return h('div', { class: 'urow' + (activePlayer(m) === mem.user_id ? ' holding' : '') },
        h('span', { class: 'av' }, mem.avatar),
        h('div', { class: 'uname' }, h('b', {}, mem.username + (mem.user_id === me ? ' (you)' : '')),
          h('small', {}, [here ? '🟢 here' : '⚪ away', here?.inCall ? '🎥' : '', mem.user_id === s.host_id ? '👑 host' : '', activePlayer(m) === mem.user_id ? '🪈 has the hookah' : ''].filter(Boolean).join(' · '))),
        val ? h('b', { class: 'metric' }, String(metric(m.challenge, val))) : '');
    }));

    const settings = m.phase === 'lobby' && s.host_id === me ? h('div', {},
      h('label', {}, 'Mode'), this.segBtns<MatchMode>([['pass', '🪈 Turns'], ['live', '⚡ Live']], s.mode, v => void r.configure({ mode: v })),
      h('label', {}, 'Challenge'), this.segBtns<Challenge>([['score', 'Score'], ['rings', 'Rings'], ['hold', 'Hold'], ['tricks', 'Tricks']], s.challenge, v => void r.configure({ challenge: v })),
      h('label', {}, 'Rounds'), this.segBtns<number>([[1, '1'], [2, '2'], [3, '3'], [5, '5']], s.rounds, v => void r.configure({ rounds: v })))
      : h('p', { class: 'hintTxt' }, `${MODE_LABEL[s.mode]} · ${CHALLENGE_LABEL[s.challenge]} · ${s.rounds} round${s.rounds > 1 ? 's' : ''}`);

    const results = m.phase === 'finished' ? h('div', { class: 'results' }, h('h3', {}, '🏆 Results'),
      ...standings(m).map(row => h('div', { class: 'urow' + (row.user === me ? ' me' : '') },
        h('span', { class: 'av' }, row.place === 1 ? '🥇' : row.place === 2 ? '🥈' : row.place === 3 ? '🥉' : String(row.place)),
        h('div', { class: 'uname' }, h('b', {}, r.name(row.user)), h('small', {}, `${row.stats.score} pts · ⭕${row.stats.rings} · ${row.stats.longestHold.toFixed(1)}s · ${row.stats.tricks} tricks`)),
        h('b', { class: 'metric' }, String(row.value))))) : '';

    this.panel.replaceChildren(
      h('div', { class: 'roomHead' },
        h('div', {}, h('small', { class: 'dim' }, 'ROOM'), h('div', { class: 'roomCode' }, s.code)),
        h('button', { onclick: async () => {
          try {
            if (navigator.share) await navigator.share({ title: 'Virtual Hookah', text: `Join my Virtual Hookah room ${s.code}`, url: link });
            else { await navigator.clipboard.writeText(link); this.deps.toast('Invite link copied'); }
          } catch { /* cancelled */ }
        } }, '🔗 Share link')),
      h('div', { class: 'roomStatus', id: 'roomStatus' }),
      h('h3', {}, `Players (${s.members.length}/${s.max_players})`), members,
      h('div', { class: 'row' },
        h('button', { onclick: () => showFriends(this.account, { invite: async (uid) => { await api.inviteToRoom(s.id, uid); } }) }, '➕ Invite friends'),
        this.inCall ? null : h('button', { class: 'primary', onclick: () => void this.startCall() }, '🎥 Join call')),
      this.inCall ? h('div', { class: 'row' },
        h('button', { class: this.micOn ? '' : 'on', onclick: () => { this.micOn = !this.micOn; this.mic?.getAudioTracks().forEach(t => { t.enabled = this.micOn; }); this.render(); } }, this.micOn ? '🎙️ Mute' : '🔇 Unmute'),
        h('button', { class: this.camOn ? '' : 'on', onclick: () => { this.camOn = !this.camOn; this.render(); } }, this.camOn ? '📷 Camera off' : '📷 Camera on'),
        h('button', { onclick: () => this.stopCall() }, '📞 Leave call')) : '',
      h('h3', {}, 'Game'), settings,
      m.phase === 'lobby' && auth ? h('button', { class: 'primary big', disabled: r.present.size < 2, onclick: async () => {
        try { await r.start(); } catch (e) { this.deps.toast(friendlyError(e)); }
      } }, r.present.size < 2 ? 'Waiting for players…' : '▶ Start game') : '',
      results,
      m.phase === 'finished' && auth ? h('button', { class: 'primary', onclick: () => void r.backToLobby() }, '🔁 Play again') : '',
      h('div', { class: 'reactions' }, ...REACTIONS.map(e => h('button', { onclick: () => r.react(e) }, e))),
      h('button', { class: 'leaveBtn', onclick: () => { if (confirm('Leave this room?')) void this.leave(); } }, '🚪 Leave room'));
    this.renderStatus();
    this.renderTiles();
  }

  private renderStatus() {
    const el = document.getElementById('roomStatus');
    const r = this.room;
    if (!el || !r) return;
    const m = r.match;
    let text = '';
    if (m.phase === 'lobby') text = r.present.size < 2 ? 'Share the code or invite friends to start.' : `${r.present.size} players here.`;
    else if (m.phase === 'playing' && m.mode === 'live') text = `⚡ ${Math.max(0, Math.ceil((m.endsAt - Date.now()) / 1000))}s left`;
    else if (m.phase === 'playing') text = `Round ${m.round}/${m.rounds} · 🪈 ${activePlayer(m) === this.uid ? 'your turn' : r.name(activePlayer(m)!)}`;
    else text = 'Game over';
    el.textContent = text;
  }

  private renderTiles() {
    const r = this.room;
    if (!r) return;
    for (const [u, tile] of this.tileEls) {
      const mem = r.members.find(x => x.user_id === u);
      const st = r.match.stats[u] ?? r.remoteStats.get(u);
      const holding = activePlayer(r.match) === u;
      tile.classList.toggle('holding', holding);
      tile.querySelector('.tileLabel')!.textContent = `${mem?.avatar ?? '🙂'} ${mem?.username ?? 'player'}${st && r.match.phase !== 'lobby' ? ' · ' + metric(r.match.challenge, st) : ''}${holding ? ' · 🪈' : ''}`;
    }
  }

  private segBtns<T extends string | number>(opts: [T, string][], cur: T, set: (v: T) => void) {
    return h('div', { class: 'seg small' }, ...opts.map(([v, l]) => h('button', { class: cur === v ? 'sel' : '', onclick: () => set(v) }, l)));
  }
}
