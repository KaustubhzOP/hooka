/**
 * Wiring: tracking → signals → state machine → effects/rendering + audio + game.
 */
import './style.css';
import { loadSettings, saveSettings, browserStorage, DEFAULT_SETTINGS, type Settings } from './settings';
import { Machine, DEFAULT_MACHINE_CONFIG, type MachineConfig, type MachineEvent } from './machine';
import { SignalProcessor, emptySignals, type Signals, type TrackingFrame } from './signals';
import { Calibration } from './calibration';
import { Tracker, describeError, IS_MOBILE, LIP_CONNECTIONS, HAND_CONNECTIONS } from './tracking';
import { SmokeRenderer, MAX_PARTICLES } from './smoke';
import { FLAVOURS, VASE_SKINS, HOSE_COLORS, resolvePreset } from './presets';
import { Hookah } from './hookah';
import { HookahAudio } from './audio';
import { SmokeDirector, faceGeometry } from './effects';
import { Backdrop } from './background';
import { drawLighting } from './lighting';
import { Game, type GameEvent } from './game';
import { UI, HINTS, drawRing, drawLandmarks, type TryKind } from './ui';
import { api, backendEnabled, friendlyError, rpcKeepalive, supabase } from './backend/supabase';
import { AccountStore } from './social/account';
import { showAuth, showUsername, showProfile, showNewPassword } from './social/account-ui';
import { showLeaderboard, showFriends } from './social/social-ui';
import { isModalOpen } from './social/modal';
import { OnlineController } from './online/controller';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ state */
const storage = browserStorage();
const settings: Settings = loadSettings(storage);

const machineConfig = (): MachineConfig => ({
  ...DEFAULT_MACHINE_CONFIG,
  blowOn: settings.blowOn, requirePinch: settings.requirePinch,
  maxInhale: settings.maxInhale, maxHold: settings.maxHold,
  ringFunnel: settings.ringFunnel, ringJaw: settings.ringJaw, sneerOn: settings.sneerOn,
  frenchPitch: settings.frenchPitch * DEG
});

const video = $<HTMLVideoElement>('video');
const stage = $('stage');
const smokeCanvas = $<HTMLCanvasElement>('smokeCanvas');
const fxCanvas = $<HTMLCanvasElement>('fxCanvas');
const lightCanvas = $<HTMLCanvasElement>('lightCanvas');
const fx = fxCanvas.getContext('2d')!;
const lightCtx = lightCanvas.getContext('2d')!;
let W = IS_MOBILE ? 720 : 1280, H = IS_MOBILE ? 960 : 720;   // canvas = video resolution once the camera runs

const tracker = new Tracker(video);
const signals = new SignalProcessor();
const calibration = new Calibration();
const hookah = new Hookah();
const audio = new HookahAudio();
const backdrop = new Backdrop($<HTMLCanvasElement>('bgCanvas'), tracker);
audio.setMuted(settings.muted);

let smoke: SmokeRenderer | null = null;
let director: SmokeDirector | null = null;
let running = false, starting = false;
let sig: Signals = emptySignals(W);
let lastFrame: TrackingFrame | null = null;
let flash = { text: '', until: 0 };
let glow = 0;
let bowlTouchT = 0;
let waterfallScored = false;
/** A "Try it" demo is playing: it must not score points or unlock achievements. */
let demo = false;

/* --------------------------------------------------------------------- UI */
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveSettings(storage, settings), 250);
}

function applySmokePreset() {
  smoke?.setPreset(resolvePreset(settings.smokePreset, settings.useCustomColor ? settings.customColor : null));
}

const game = new Game(storage, onGameEvent);

/* -------------------------------------------------- accounts, scores, online */
const account = new AccountStore();
let runSession: string | null = null;
let runSessionPending: Promise<string | null> | null = null;
let saving = false;
const pendingRoomCode = new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-Z2-9]/g, '') || null;
let pendingRoomTried = false;

const online = new OnlineController(account, {
  toast: t => ui.toast(t),
  log: t => ui.log(t),
  banner: (text, ms = 2200) => { ui.turnBanner(text); if (text) setTimeout(() => ui.turnBanner(null), ms); },
  enteredRoom: () => {
    void autoSaveRun();
    ui.setOnlineActive(true);
    game.setMode('online');
    signals.slot = null; signals.reset();
    machine.reset(); director?.reset();
    void tracker.setNumFaces(1);
    if (!running) flashHint('Start the camera to play in the room.', 4000);
    renderGame();
  },
  leftRoom: () => { ui.setOnlineActive(false); applyPlayMode(); },
  matchStarted: roomId => {
    game.setMode('online');
    machine.reset(); director?.reset();
    runSession = null;
    api.startGame('online', roomId).then(id => { runSession = id; }).catch(e => ui.log('start_game: ' + friendlyError(e)));
    renderGame();
  },
  matchFinished: () => {
    const id = runSession;
    runSession = null;
    if (id && game.run.hits > 0) {
      api.submitScore(id, game.run)
        .then(r => { if (r.saved) ui.toast(`Score saved to the leaderboard: ${game.run.score} pts${r.personal_best ? ' · personal best!' : ''}`); })
        .catch(e => ui.log('submit_score: ' + friendlyError(e)));
    }
  },
  layout: () => fitStage()
});

/** A server-side game session bounds what a run can plausibly score (see submit_score). */
async function ensureRunSession(): Promise<void> {
  if (runSession || !account.canPlayOnline || game.mode !== 'solo') return;
  runSessionPending ??= api.startGame('solo')
    .then(id => (runSession = id))
    .catch(e => { ui.log('start_game: ' + friendlyError(e)); return null; })
    .finally(() => { runSessionPending = null; });
  await runSessionPending;
}

async function saveRun(): Promise<void> {
  if (!account.signedIn) { showAuth(account, 'signin', 'Sign in to save your runs to the leaderboard.'); return; }
  if (!account.profile) { showUsername(account, true); return; }
  if (game.run.hits === 0 || saving) return;
  saving = true; renderGame();
  try {
    await ensureRunSession();
    if (!runSession) throw new Error('Could not start a game session. Try again.');
    const run = { ...game.run };
    const r = await api.submitScore(runSession, run);
    ui.toast(r.saved ? `🏁 Run saved: ${run.score} pts${r.personal_best ? ' · personal best!' : ''}${r.rank ? ` · rank #${r.rank}` : ''}` : 'Nothing to save yet');
    game.resetRun();
  } catch (e) {
    ui.toast(friendlyError(e));
    if ((e as { code?: string }).code === 'implausible_score' || (e as { code?: string }).code === 'already_submitted') game.resetRun();
  } finally {
    saving = false; runSession = null; renderGame();
    void ensureRunSession();
  }
}

/** Save a solo run quietly (mode switch, tab closing). */
async function autoSaveRun(keepalive = false): Promise<void> {
  if (!runSession || game.mode !== 'solo' || game.run.hits === 0) return;
  const id = runSession, r = game.run;
  runSession = null;
  const args = { p_session: id, p_score: Math.round(r.score), p_rings: r.rings, p_best_combo: r.bestCombo, p_longest_hold: Math.round(r.longestHold * 10) / 10, p_hits: r.hits };
  if (keepalive) await rpcKeepalive('submit_score', args);
  else await api.submitScore(id, r).catch(() => {});
}
addEventListener('pagehide', () => { void autoSaveRun(true); });

function renderAccount() {
  const btn = $('accountBtn');
  const lbl = btn.querySelector('.lbl')!, ic = btn.querySelector('.ic')!;
  if (account.profile) { ic.textContent = account.profile.avatar; lbl.textContent = account.profile.username; }
  else if (account.signedIn) { ic.textContent = '👤'; lbl.textContent = 'Pick username'; }
  else { ic.textContent = '👤'; lbl.textContent = 'Sign in'; }
}

// notifications: friend requests and room invites (realtime + a slow poll as a fallback)
let notifyTimer = 0;
let notifyChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
let knownInvites: Set<number> | null = null;
const setBadge = (id: string, n: number) => { const b = $(id); b.hidden = n === 0; b.textContent = String(n); };
async function pollNotifications() {
  if (!account.canPlayOnline) return;
  try {
    const [friends, invites] = await Promise.all([api.myFriends(), api.myInvites()]);
    setBadge('friendsBadge', friends.filter(f => f.status === 'pending' && f.direction === 'incoming').length);
    setBadge('onlineBadge', invites.length);
    if (knownInvites) for (const i of invites) if (!knownInvites.has(i.invite_id)) ui.toast(`🌐 ${i.from_username} invited you to play: press Online`);
    knownInvites = new Set(invites.map(i => i.invite_id));
  } catch { /* offline */ }
}
function startNotifications() {
  if (notifyTimer || !supabase || !account.uid) return;
  void pollNotifications();
  notifyTimer = window.setInterval(() => void pollNotifications(), 30_000);
  const uid = account.uid;
  notifyChannel = supabase.channel(`notify-${uid}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_invites', filter: `to_user=eq.${uid}` }, () => void pollNotifications())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: `addressee=eq.${uid}` }, () => void pollNotifications())
    .subscribe();
}
function stopNotifications() {
  clearInterval(notifyTimer); notifyTimer = 0;
  if (notifyChannel) void supabase?.removeChannel(notifyChannel);
  notifyChannel = null; knownInvites = null;
  setBadge('friendsBadge', 0); setBadge('onlineBadge', 0);
}

async function initAccount() {
  const social = ['boardBtn', 'friendsBtn', 'onlineBtn', 'accountBtn'];
  if (!backendEnabled) { social.forEach(id => { $(id).hidden = true; }); return; }
  $('boardBtn').onclick = () => showLeaderboard(account);
  $('friendsBtn').onclick = () => showFriends(account, online.inRoom && online.room?.id
    ? { invite: uid => api.inviteToRoom(online.room!.id!, uid), onChange: () => void pollNotifications() }
    : { onChange: () => void pollNotifications() });
  $('onlineBtn').onclick = () => online.inRoom ? $('roomPanel').scrollIntoView({ behavior: 'smooth' }) : online.openLobby();
  $('accountBtn').onclick = () => account.signedIn ? showProfile(account) : showAuth(account, 'signin');
  account.on((a, event) => {
    renderAccount();
    if (event === 'recovery') showNewPassword();
    if (a.needsUsername && !isModalOpen()) showUsername(a, true);
    if (a.canPlayOnline) {
      startNotifications();
      if (running) void ensureRunSession();
      if (pendingRoomCode && !pendingRoomTried && !online.inRoom) { pendingRoomTried = true; void online.join(pendingRoomCode); }
    } else {
      stopNotifications();
      if (event === 'SIGNED_OUT' && online.inRoom) void online.leave();
    }
    renderGame();
  });
  await account.init();
  if (pendingRoomCode && !account.signedIn) showAuth(account, 'signin', `Sign in to join room ${pendingRoomCode}.`);
}

const ui: UI = new UI(settings, {
  start: () => void start(),
  calibrate: () => startCalibration(),
  calSkip: () => { const r = calibration.skip(); if (r) finishCalibration(r); },
  calCancel: () => cancelCalibration(),
  tryIt: k => tryIt(k),
  reset: () => resetAll(),
  toggleMute: () => { audio.ensure(); change('muted', !settings.muted); },
  toggleDebug: () => change('debugOpen', !settings.debugOpen),
  restoreDefaults: () => {
    for (const k of ['blowOn', 'penNear', 'penExt', 'pinchMax', 'maxInhale', 'maxHold', 'requirePinch',
                     'ringFunnel', 'ringJaw', 'sneerOn', 'frenchPitch', 'waterfallPitch', 'pitchOffset'] as const)
      (settings as unknown as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    machine.cfg = machineConfig();
    ui.syncSettings(); persist();
    ui.log('thresholds restored to defaults');
  },
  flipCoals: () => flipCoals('button'),
  freshCoals: () => { hookah.coals.fresh(); audio.ensure(); audio.crackle(); ui.log('fresh coals'); },
  resetStats: () => { game.resetStats(); renderGame(); },
  saveRun: () => void saveRun(),
  change: (k, v) => change(k, v)
});

function change<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings[key] = value;
  switch (key) {
    case 'blowOn': case 'requirePinch': case 'maxInhale': case 'maxHold':
    case 'ringFunnel': case 'ringJaw': case 'sneerOn': case 'frenchPitch':
      machine.cfg = machineConfig(); break;
    case 'smokePreset': case 'useCustomColor': case 'customColor':
      applySmokePreset();
      if (key === 'smokePreset') { ui.log('flavour: ' + FLAVOURS[settings.smokePreset].name); game.flavour(FLAVOURS[settings.smokePreset].name); }
      break;
    case 'muted': audio.setMuted(settings.muted); ui.setMuted(settings.muted); break;
    case 'debugOpen': ui.setDebugOpen(settings.debugOpen); break;
    case 'background': void applyBackground(); break;
    case 'playMode':
      if (settings.playMode === 'online') {           // online is a room, not a stored mode
        settings.playMode = online.inRoom ? 'online' : 'solo';
        online.openLobby();
        ui.syncSettings();
        ui.setOnlineActive(online.inRoom);
        return;
      }
      if (online.inRoom) { void online.leave(); }
      applyPlayMode(); break;
    case 'localPlayers': applyPlayMode(); break;
  }
  ui.syncSettings();
  persist();
}

function flashHint(text: string, ms: number) { flash = { text, until: performance.now() + ms }; }

/* ------------------------------------------------------------- game events */
function onGameEvent(e: GameEvent) {
  switch (e.type) {
    case 'unlock': ui.toast(`${e.achievement.emoji} Achievement: ${e.achievement.name}`); ui.log('achievement: ' + e.achievement.name); break;
    case 'points': if (e.points) ui.toast(`${e.points > 0 ? '+' : ''}${e.points} ${e.label}`, 'pts'); break;
    case 'combo': if (e.rings > 1) ui.toast(`⭕ ×${e.rings} combo${e.best ? ' · new best!' : ''}`, 'combo'); break;
    case 'run': online.runUpdated(e.run, e.hitEnded); break;
    case 'turn': {
      signals.slot = e.player;
      signals.reset();
      const name = game.players[e.player].name;
      ui.turnBanner(`${name}, your turn! 🖊️ Pass the pen`);
      setTimeout(() => ui.turnBanner(null), 2200);
      ui.log(`turn → ${name}`);
      break;
    }
  }
  renderGame();
}

function renderGame() {
  ui.renderGame(game, { signedIn: account.signedIn, hasProfile: !!account.profile, saving });
}

function localPlayers(): number { return settings.playMode === 'local' ? Math.max(2, Math.min(4, settings.localPlayers)) : 1; }

function applyPlayMode() {
  const mode = online.inRoom ? 'online' : settings.playMode === 'local' ? 'local' : 'solo';
  void autoSaveRun();
  game.setMode(mode, localPlayers());
  signals.slot = mode === 'local' ? game.turn : null;
  signals.reset();
  machine.reset(); director?.reset();
  void tracker.setNumFaces(mode === 'local' ? localPlayers() : 1);
  if (mode === 'local') {
    ui.turnBanner(`${localPlayers()} players on this device: Player 1 is on the left, the hose passes left → right`);
    setTimeout(() => ui.turnBanner(null), 2800);
  }
  runSession = null;
  renderGame();
}

async function applyBackground() {
  const mode = settings.background;
  stage.classList.toggle('bgOn', false);
  if (mode === 'none') { ui.setBackgroundNote('Cuts you out of the camera image (on your device) and puts you in a lounge.'); return; }
  if (!running) { ui.setBackgroundNote('The background switches on once the camera is running.'); return; }
  ui.setBackgroundNote('Loading the segmentation model…');
  try {
    await backdrop.ensure();
    ui.setBackgroundNote(IS_MOBILE ? 'Background on. On phones this costs some frame rate.' : 'Background on. Cut out on your device: nothing is uploaded.');
  } catch (e) {
    ui.setBackgroundNote('Could not load the segmentation model: ' + (e as Error).message);
    ui.log('background failed: ' + (e as Error).message);
  }
}

/* ---------------------------------------------------------------- machine */
function onMachineEvent(e: MachineEvent) {
  const geo = faceGeometry(sig, W, H, running);
  switch (e.type) {
    case 'transition':
      ui.log(`${e.from} → ${e.to}  (${e.reason})`);
      if (e.to === 'EXHALING') waterfallScored = false;
      break;
    case 'inhaleRejected':
      ui.log(`inhale rejected: too short (${e.charge.toFixed(2)}s < ${DEFAULT_MACHINE_CONFIG.minInhale}s)`);
      flashHint('Too short: keep sipping a little longer to inhale.', 2200);
      break;
    case 'exhale': {
      const x = e.exhale;
      ui.log(`exhale: ${x.kind}, ${x.duration.toFixed(1)}s, strength ${x.strength.toFixed(2)}`);
      if (x.kind === 'cough') { audio.cough(); flashHint('*cough cough*, you held it too long!', 2000); }
      if (x.kind === 'nose') flashHint('Dragon mode: smoke through the nose 🐉', 1800);
      if (!demo) game.exhale(x.kind, machine.hold);
      break;
    }
    case 'ring':
      director?.ring(geo, e.strength, settings);
      audio.ringPuff(e.strength);
      game.ring(e.index);
      ui.log(`ring #${e.index} (strength ${e.strength.toFixed(2)}, ${e.remaining.toFixed(1)}s of smoke left)`);
      if (e.index === 1) flashHint('Smoke ring! Close your mouth, then “O” again for another…', 1800);
      break;
    case 'ghost':
      if (e.phase === 'out') { director?.ghostOut(geo); flashHint('👻 Ghost! Sip it back in, quick!', 1500); }
      if (e.phase === 'in') { director?.ghostIn(geo); audio.slurp(); game.trick('ghost'); flashHint('Ghost recalled 👻✨', 1500); }
      if (e.phase === 'lost') { director?.ghostLost(); flashHint('The ghost floated away…', 1600); }
      ui.log('ghost ' + e.phase);
      break;
    case 'trick':
      ui.log(`French inhale ${e.active ? 'started' : 'ended'}`);
      if (e.active) { audio.slurp(); game.trick('french'); }
      break;
    case 'hitEnd':
      if (!demo) { game.hitEnd(e.outcome, e.held); if (game.mode === 'solo') void ensureRunSession(); }
      demo = false;
      break;
  }
}
const machine = new Machine(machineConfig(), onMachineEvent);

/* ----------------------------------------------------------------- layout */
function fitStage() {
  const wrap = $('stageWrap');
  const cs = getComputedStyle(wrap);
  const aw = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const tiles = document.getElementById('tiles')!;
  const tilesH = document.body.classList.contains('inCall') ? tiles.offsetHeight + 10 : 0;
  const ah = (narrow ? window.innerHeight * 0.72 : wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) - tilesH;
  const ar = W / H;
  const w = Math.max(200, Math.min(aw, ah * ar));
  stage.style.width = Math.floor(w) + 'px';
  stage.style.height = Math.floor(w / ar) + 'px';
}

function setResolution(w: number, h: number) {
  if (!w || !h) return;
  W = w; H = h;
  fxCanvas.width = w; fxCanvas.height = h;
  lightCanvas.width = w; lightCanvas.height = h;
  smoke?.resize(w, h);
  fitStage();
}

new ResizeObserver(fitStage).observe($('stageWrap'));
window.addEventListener('resize', fitStage);
video.addEventListener('resize', () => { if (running) setResolution(video.videoWidth, video.videoHeight); });

/* ------------------------------------------------------------------ start */
async function start() {
  audio.ensure();
  if (running || starting) return;
  starting = true;
  ui.showCard({ title: 'Starting…', body: 'Loading the tracking models and asking for camera access.', busy: true });
  try {
    const [dims, delegate] = await Promise.all([tracker.startCamera(), tracker.loadModels()]);
    await tracker.setNumFaces(game.mode === 'local' ? localPlayers() : 1);
    setResolution(dims.width, dims.height);
    signals.reset();
    running = true;
    ui.setRunning(true);
    void ensureRunSession();
    ui.showCard(null);
    ui.log(`camera ${dims.width}×${dims.height}, models on ${delegate}${IS_MOBILE ? ' (mobile)' : ''}`);
    flashHint(settings.calibrated
      ? 'Bring the pen to your lips and sip to inhale.'
      : 'Tip: press Calibrate first (4 quick steps). It makes every gesture far more accurate.', 6000);
    if (settings.background !== 'none') void applyBackground();
  } catch (err) {
    console.error(err);
    const d = describeError(err);
    ui.log('ERROR: ' + d.title + ' — ' + ((err as Error)?.message ?? err));
    ui.showCard({
      title: d.title, body: d.body, error: true,
      actions: [
        { label: 'Retry', primary: true, fn: () => void start() },
        { label: 'Try the smoke without a camera', fn: () => { ui.showCard(null); tryIt('smoke'); } }
      ]
    });
  } finally {
    starting = false;
  }
}

tracker.onEnded = () => {
  running = false;
  ui.setRunning(false);
  machine.reset(); calibration.cancel(); ui.setCalibration(null);
  stage.classList.remove('bgOn');
  ui.log('camera stopped');
  ui.showCard({ title: 'Camera disconnected', body: 'The camera stopped sending video. Reconnect it and press Retry.', error: true,
    actions: [{ label: 'Retry', primary: true, fn: () => void start() }] });
};

/* ------------------------------------------------------------ calibration */
function startCalibration() {
  if (!running) { flashHint('Start the camera first.', 2000); return; }
  audio.ensure();
  machine.reset(); director?.reset();
  calibration.start();
  ui.log('calibration started');
}

function cancelCalibration() {
  calibration.cancel(); ui.setCalibration(null); ui.log('calibration cancelled');
}

function stepCalibration(dt: number) {
  const r = calibration.step(dt, { blow: sig.blow, funnel: sig.funnel, jaw: sig.jaw, sneer: sig.sneer, pitch: signals.neutralPitchSample });
  ui.setCalibration(calibration.active ? calibration.status() : null);
  if (r) finishCalibration(r);
}

function finishCalibration(r: NonNullable<Calibration['result']>) {
  ui.setCalibration(null);
  const f = (v: number) => v.toFixed(2);
  ui.log(`calibration: neutral blow ${f(r.neutral.blow)} funnel ${f(r.neutral.funnel)} jaw ${f(r.neutral.jaw)} sneer ${f(r.neutral.sneer)} pitch ${(r.pitchOffset / DEG).toFixed(0)}°`);
  ui.log(`  sip blow ${f(r.sip.blow)} · O funnel ${f(r.oh.funnel)} jaw ${f(r.oh.jaw)} · scrunch ${f(r.scrunch.sneer)}`);
  const applied: string[] = [];
  if (r.blowOn != null) { settings.blowOn = r.blowOn; applied.push(`sip ${f(r.blowOn)}`); }
  if (r.ringFunnel != null && r.ringJaw != null) { settings.ringFunnel = r.ringFunnel; settings.ringJaw = r.ringJaw; applied.push(`O ${f(r.ringFunnel)}/${f(r.ringJaw)}`); }
  if (r.sneerOn != null) { settings.sneerOn = r.sneerOn; applied.push(`scrunch ${f(r.sneerOn)}`); }
  settings.pitchOffset = Math.max(-1, Math.min(1, r.pitchOffset));
  settings.calibrated = true;
  machine.cfg = machineConfig();
  ui.syncSettings(); persist();
  ui.log('calibrated → ' + (applied.join(', ') || 'no thresholds changed'));
  game.unlock('tuned');
  const names: Record<string, string> = { sip: 'the sip', oh: 'the “O”', scrunch: 'the nose scrunch' };
  if (r.weak.length) flashHint(`Calibrated, but ${r.weak.map(w => names[w]).join(' and ')} barely registered: exaggerate it a bit more and calibrate again.`, 6500);
  else flashHint('Calibrated ✓  Pen to your lips and sip to inhale.', 4000);
}

/* ------------------------------------------------------------------ misc */
function tryIt(kind: TryKind) {
  audio.ensure();
  if (calibration.active || !smoke || !director) return;
  const geo = faceGeometry(sig, W, H, running);
  if (kind === 'smoke' || kind === 'nose' || kind === 'waterfall') { demo = true; director.reset(); }
  switch (kind) {
    case 'smoke': machine.forceExhale('test', 0.9, 3); break;
    case 'nose': machine.forceExhale('nose', 0.85, 2.5); break;
    case 'ring': director.ring(geo, 0.85, settings); audio.ringPuff(0.85); break;
    case 'ghost':
      director.ghostOut(geo);
      setTimeout(() => { director!.ghostIn(faceGeometry(sig, W, H, running)); audio.slurp(); }, 1500);
      break;
    case 'french': director.demoFrench(3); audio.slurp(); flashHint('French inhale: smoke flows from your mouth up into your nose', 2500); break;
    case 'waterfall': director.demoWaterfall(3); machine.forceExhale('test', 0.8, 2.5); break;
  }
}

function flipCoals(how: string) {
  audio.ensure();
  if (hookah.coals.flip()) {
    audio.crackle();
    game.unlock('flipper');
    ui.log('coals flipped (' + how + ')');
    flashHint('🔥 Coals flipped: thick smoke again!', 1500);
  } else if (hookah.coals.fuel <= 0) flashHint('The coals are burnt out. Get fresh coals in the Hookah tab.', 2500);
}

function resetAll() {
  machine.reset(); calibration.cancel(); ui.setCalibration(null); smoke?.clear(); director?.reset();
  ui.log('reset');
}

// Tap the bowl on screen to flip the coals.
stage.addEventListener('pointerdown', e => {
  const r = stage.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
  const b = Hookah.bowlRect(W, H);
  const pad = (b.x1 - b.x0) * 0.4;
  if (x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad) flipCoals('tap');
});

/* ------------------------------------------------------------------- loop */
let last = performance.now(), frames = 0, fps = 0, fpsT = last, slowT = 0, coalUiT = 0;

function loop(now: number) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  const t = now / 1000;

  // 1. tracking → signals
  if (running) {
    const f = tracker.detect(now);
    if (f) { lastFrame = f; sig = signals.update(f, { ...settings, pitchOffset: settings.pitchOffset }); frames++; }
  } else sig = emptySignals(W);
  if (now - fpsT >= 1000) {
    fps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now;
    adaptQuality();
  }

  // 2. signals → state machine (or calibration)
  if (calibration.active) stepCalibration(dt);
  else if (online.inRoom && !online.canPlay() && machine.state === 'IDLE') machine.cooldown = 0.2;   // not your turn: wait
  else machine.step(dt, sig);
  online.tick(now);

  // 3. smoke
  const geo = faceGeometry(sig, W, H, running);
  let whoosh = 0;
  if (smoke && director) {
    smoke.heat = hookah.coals.heat;
    const out = director.update(dt, machine, sig, geo, settings, running);
    whoosh = out.whoosh;
    if (out.waterfall && !waterfallScored) { waterfallScored = true; if (!demo) game.trick('waterfall'); flashHint('🌊 Waterfall!', 1500); }
    if (out.stirred > 15) game.trick('stir');
    if (out.gust > 15) game.trick('gust');
    const L = hookah.light(W, H);
    smoke.setLight(settings.lightSmoke ? { x: L.x, y: L.y, color: L.color, radius: Math.max(W, H) * 0.9, intensity: L.intensity * 0.45 * settings.lightIntensity } : null);
    smoke.update(dt);
    smoke.render();
  }

  // 4. backdrop, light, hookah, hose, ring, debug overlay
  const bgActive = running && settings.background !== 'none' && backdrop.ready;
  stage.classList.toggle('bgOn', bgActive);
  if (bgActive) backdrop.render(settings.background, video, W, H, t, true);

  const inhaling = machine.state === 'INHALING';
  const chargeFrac = machine.charge / settings.maxInhale;
  const glowTarget = inhaling ? 0.55 + 0.45 * chargeFrac : machine.state === 'HOLDING' ? 0.3 : 0;
  glow += (glowTarget - glow) * Math.min(1, dt * (glowTarget > glow ? 6 : 1.5));
  const p = sig.pen;
  fx.clearRect(0, 0, W, H);
  hookah.draw(fx, W, H, {
    t, dt, draw: inhaling ? 0.45 + 0.55 * chargeFrac : 0, glow,
    pen: p ? { back: { x: p.grip.x - p.dir.x * p.handSize * 0.9, y: p.grip.y - p.dir.y * p.handSize * 0.9 }, dir: p.dir, length: p.handSize * 0.55 } : null,
    skin: VASE_SKINS[settings.vaseSkin] ?? VASE_SKINS[0],
    hose: HOSE_COLORS[settings.hoseColor] ?? HOSE_COLORS[0],
    water: resolvePreset(settings.smokePreset, settings.useCustomColor ? settings.customColor : null).water,
    power: settings.coalPower
  });
  const L = hookah.light(W, H);
  drawLighting(lightCtx, W, H, {
    coal: L, led: L.led, ledPos: L.ledPos, face: sig.mouth, faceW: sig.faceW,
    strength: settings.lightIntensity, faceLight: settings.faceLight && running
  });
  drawRing(fx, machine, running ? sig.mouth : (machine.state === 'EXHALING' ? geo.mouth : null), geo.faceW, sig.penNear, t);
  if (settings.showLandmarks && running && lastFrame) {
    drawLandmarks(fx, null, lastFrame.hands, LIP_CONNECTIONS, HAND_CONNECTIONS, sig, W, H);
    for (const face of lastFrame.faces) drawLandmarks(fx, face.landmarks, [], LIP_CONNECTIONS, HAND_CONNECTIONS, { ...sig, pen: null }, W, H);
  }

  // outgoing call video: the whole stage (camera + light + smoke + hookah)
  if (online.inCall) online.composite([
    bgActive ? { src: $<HTMLCanvasElement>('bgCanvas') } : { src: video, mirror: true },
    { src: lightCanvas, blend: 'screen' },
    { src: smokeCanvas },
    { src: fxCanvas }
  ], W, H);

  // fingers in the bowl flip the coals
  if (running && sig.hands.length) {
    const b = Hookah.bowlRect(W, H);
    const inBowl = sig.hands.some(h => h.tips.some(q => q.x > b.x0 && q.x < b.x1 && q.y > b.y0 && q.y < b.y1));
    bowlTouchT = inBowl ? bowlTouchT + dt : 0;
    if (bowlTouchT > 0.25) { flipCoals('hand'); bowlTouchT = -1.5; }
  }

  // 5. audio + HUD
  audio.update(dt, inhaling ? (0.5 + 0.5 * chargeFrac) * (0.4 + 0.6 * hookah.coals.heat) : 0, chargeFrac, whoosh);
  ui.updateHud(now, machine, sig, calibration.active, fps, smoke?.count ?? 0, running);
  ui.setHint(currentHint(now));
  if (now - coalUiT > 400) { coalUiT = now; ui.setCoals(hookah.coals.heat, hookah.coals.fuel); }
}

/** Drop the particle cap when the frame rate sags (phones, old laptops); raise it again when there is headroom. */
function adaptQuality() {
  if (!smoke || !running) return;
  if (fps > 0 && fps < 22) slowT++; else slowT = Math.max(0, slowT - 1);
  if (slowT >= 3 && smoke.cap > 300) { smoke.cap -= 100; slowT = 0; ui.log(`low fps → smoke cap ${smoke.cap}`); }
  else if (fps >= 40 && smoke.cap < (IS_MOBILE ? 600 : MAX_PARTICLES)) smoke.cap += 50;
}

function currentHint(now: number): string {
  if (now < flash.until) return flash.text;
  if (!running || calibration.active) return '';
  const wait = online.waitingText();
  if (wait && machine.state === 'IDLE') return wait;
  const who = game.mode === 'local' ? `${game.players[game.turn].name}: ` : '';
  if (!sig.faceVisible) return who + 'I can’t see your face: face the camera, with light in front of you.';
  if (machine.state === 'IDLE') {
    if (hookah.coals.burntOut) return 'The coals are burnt out: get fresh coals in the Hookah tab.';
    if (hookah.coals.needsFlip) return 'The coals are cooling: touch the bowl (or press X) to flip them.';
    if (!sig.pen) return who + 'Hold the pen like a mouthpiece and keep your hand in view…';
  }
  return who + HINTS[machine.state];
}

/* ------------------------------------------------------------------- keys */
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || isModalOpen()) return;
  if (t instanceof HTMLInputElement && !['range', 'checkbox'].includes(t.type)) return;
  if (t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
  const k = e.key.toLowerCase();
  const n = parseInt(k, 10);
  if (n >= 1 && n <= Math.min(9, FLAVOURS.length)) { change('smokePreset', n - 1); audio.ensure(); }
  else if (k === 'c') startCalibration();
  else if (k === 't') tryIt('smoke');
  else if (k === 'o') tryIt('ring');
  else if (k === 'n') tryIt('nose');
  else if (k === 'g') tryIt('ghost');
  else if (k === 'f') tryIt('french');
  else if (k === 'w') tryIt('waterfall');
  else if (k === 'x') flipCoals('key');
  else if (k === 'r') resetAll();
  else if (k === 'd') change('debugOpen', !settings.debugOpen);
  else if (k === 'l') change('showLandmarks', !settings.showLandmarks);
  else if (k === 'm') { audio.ensure(); change('muted', !settings.muted); }
  else if (k === ' ' && calibration.active) { const r = calibration.skip(); if (r) finishCalibration(r); }
  else if (k === 'escape' && calibration.active) cancelCalibration();
  else return;
  e.preventDefault();
});

/* ------------------------------------------------------------------- boot */
try {
  smoke = new SmokeRenderer(smokeCanvas, W, H);
  if (IS_MOBILE) smoke.cap = 600;
  director = new SmokeDirector(smoke);
  applySmokePreset();
} catch (e) {
  console.error(e);
  ui.log('WebGL unavailable: smoke disabled');
  flashHint('WebGL is unavailable in this browser, so the smoke cannot be drawn.', 8000);
}
setResolution(W, H);
applyPlayMode();
void initAccount();
ui.log('ready: press “Start camera”');
requestAnimationFrame(loop);

// Dev-only handle for poking at the app from the console / browser tests.
if (import.meta.env.DEV) Object.assign(window, { __hookah: { account, online, machine, audio, settings, calibration, game, hookah, signals, get smoke() { return smoke; }, get director() { return director; }, get sig() { return sig; }, get frame() { return lastFrame; } } });
