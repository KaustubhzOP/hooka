/**
 * Ring challenge, scoring, achievements and the 2-player turn order.
 * DOM-free (storage is injected), so it can be unit tested.
 */
import type { ExhaleKind } from './machine';

export interface Achievement { id: string; emoji: string; name: string; desc: string }

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_hit', emoji: '💨', name: 'First puff', desc: 'Finish your first exhale' },
  { id: 'first_ring', emoji: '⭕', name: 'Ring master', desc: 'Blow a smoke ring' },
  { id: 'combo3', emoji: '🎯', name: 'Triple O', desc: '3 rings from one inhale' },
  { id: 'combo5', emoji: '🌀', name: 'Ring cascade', desc: '5 rings from one inhale' },
  { id: 'dragon', emoji: '🐉', name: 'Dragon', desc: 'Exhale through your nose' },
  { id: 'french', emoji: '🥖', name: 'French inhale', desc: 'Let smoke flow from mouth to nose' },
  { id: 'ghost', emoji: '👻', name: 'Ghostbuster', desc: 'Sip a ghost puff back in' },
  { id: 'waterfall', emoji: '🌊', name: 'Waterfall', desc: 'Pour the smoke down with your head tilted' },
  { id: 'stir', emoji: '✋', name: 'Smoke bender', desc: 'Swirl smoke with your hand' },
  { id: 'gust', emoji: '🌬️', name: 'Gust', desc: 'Blow smoke in the air away' },
  { id: 'iron_lungs', emoji: '🫁', name: 'Iron lungs', desc: 'Hold 5 s, then blow without coughing' },
  { id: 'rookie', emoji: '😵', name: 'Rookie', desc: 'Hold it too long and cough' },
  { id: 'flipper', emoji: '🔥', name: 'Coal flipper', desc: 'Flip the coals' },
  { id: 'explorer', emoji: '🍹', name: 'Flavour explorer', desc: 'Try 5 different flavours' },
  { id: 'duo', emoji: '🤝', name: 'Puff, puff, pass', desc: 'Finish a 2-player turn' },
  { id: 'tuned', emoji: '🎛️', name: 'Tuned in', desc: 'Complete the calibration' }
];

export interface Stats {
  bestRings: number;
  totalRings: number;
  bestHold: number;
  bestScore: number;
  hits: number;
  flavours: string[];
  unlocked: string[];
}

export interface Player { name: string; score: number; hits: number; bestRings: number }

/** Totals for the current run (what gets submitted to the leaderboard). */
export interface RunStats { score: number; rings: number; bestCombo: number; longestHold: number; hits: number; tricks: number }
export const emptyRun = (): RunStats => ({ score: 0, rings: 0, bestCombo: 0, longestHold: 0, hits: 0, tricks: 0 });
export type GameMode = 'solo' | 'local' | 'online';
export const MAX_LOCAL_PLAYERS = 4;

export type GameEvent =
  | { type: 'unlock'; achievement: Achievement }
  | { type: 'points'; points: number; label: string; player: number }
  | { type: 'combo'; rings: number; best: boolean }
  | { type: 'turn'; player: number }
  /** Something about the run changed (online mode broadcasts it). */
  | { type: 'run'; run: RunStats; hitEnded: boolean };

export const STATS_KEY = 'virtual-hookah.stats.v1';
const newPlayer = (n: number): Player => ({ name: `Player ${n}`, score: 0, hits: 0, bestRings: 0 });
const emptyStats = (): Stats => ({ bestRings: 0, totalRings: 0, bestHold: 0, bestScore: 0, hits: 0, flavours: [], unlocked: [] });

export class Game {
  stats: Stats;
  mode: GameMode = 'solo';
  players: Player[] = [newPlayer(1)];
  turn = 0;
  /** This device's run (solo / online). */
  run: RunStats = emptyRun();
  /** Rings in the current hit (the combo). */
  combo = 0;
  private heldThisHit = 0;
  private tricksThisHit = new Set<string>();

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null, private emit: (e: GameEvent) => void = () => {}) {
    this.stats = emptyStats();
    try {
      const raw = JSON.parse(storage?.getItem(STATS_KEY) ?? 'null');
      if (raw && typeof raw === 'object') this.stats = { ...emptyStats(), ...raw };
    } catch { /* ignore */ }
  }

  get current(): Player { return this.players[this.mode === 'local' ? this.turn : 0]; }

  /** solo: 1 player; local: 2–4 players taking turns on this device; online: this device's player. */
  setMode(mode: GameMode, localPlayers = 2): void {
    this.mode = mode;
    this.turn = 0;
    const n = mode === 'local' ? Math.max(2, Math.min(MAX_LOCAL_PLAYERS, localPlayers)) : 1;
    this.players = Array.from({ length: n }, (_, i) => newPlayer(i + 1));
    this.combo = 0;
    this.resetRun();
  }

  resetRun(): void {
    this.run = emptyRun();
    this.players.forEach(p => { p.score = 0; p.hits = 0; p.bestRings = 0; });
    this.tricksThisHit.clear();
    this.combo = 0;
  }

  unlock(id: string): boolean {
    if (this.stats.unlocked.includes(id)) return false;
    const a = ACHIEVEMENTS.find(x => x.id === id);
    if (!a) return false;
    this.stats.unlocked.push(id);
    this.save();
    this.emit({ type: 'unlock', achievement: a });
    return true;
  }

  private add(points: number, label: string) {
    const p = this.current;
    p.score = Math.max(0, p.score + points);
    if (this.mode !== 'local') this.run.score = p.score;
    this.stats.bestScore = Math.max(this.stats.bestScore, p.score);
    this.emit({ type: 'points', points, label, player: this.mode === 'local' ? this.turn : 0 });
    if (this.mode !== 'local') this.emit({ type: 'run', run: { ...this.run }, hitEnded: false });
  }

  /** A ring was puffed; index = rings so far in this hit. */
  ring(index: number): void {
    this.combo = index;
    this.stats.totalRings++;
    this.run.rings++;
    this.run.bestCombo = Math.max(this.run.bestCombo, index);
    const best = index > this.stats.bestRings;
    if (best) this.stats.bestRings = index;
    this.current.bestRings = Math.max(this.current.bestRings, index);
    this.add(15 * index, index > 1 ? `ring ×${index}` : 'ring');
    this.emit({ type: 'combo', rings: index, best });
    this.unlock('first_ring');
    if (index >= 3) this.unlock('combo3');
    if (index >= 5) this.unlock('combo5');
    this.save();
  }

  exhale(kind: ExhaleKind, held: number): void {
    this.heldThisHit = held;
    if (kind === 'blow') { this.add(10 + Math.round(held * 3), 'exhale'); if (held >= 5) this.unlock('iron_lungs'); }
    if (kind === 'nose') { this.add(20 + Math.round(held * 3), 'dragon'); this.unlock('dragon'); }
    if (kind === 'cough') { this.add(-5, 'cough'); this.unlock('rookie'); }
  }

  /** French inhale, ghost recall, waterfall, stir, gust: scored once per hit. */
  trick(id: 'french' | 'ghost' | 'waterfall' | 'stir' | 'gust'): void {
    this.unlock(id);
    if (this.tricksThisHit.has(id)) return;
    this.tricksThisHit.add(id);
    if (id !== 'stir' && id !== 'gust') this.run.tricks++;
    const pts = { french: 15, ghost: 20, waterfall: 10, stir: 0, gust: 0 }[id];
    if (pts) this.add(pts, id === 'ghost' ? 'ghost recalled' : id);
  }

  flavour(name: string): void {
    if (!this.stats.flavours.includes(name)) { this.stats.flavours.push(name); this.save(); }
    if (this.stats.flavours.length >= 5) this.unlock('explorer');
  }

  /** The hit is over: book-keeping, and in 2-player mode pass the hose. */
  hitEnd(outcome: 'exhaled' | 'rings' | 'ghostLost' | 'rejected', held: number): void {
    if (outcome === 'rejected') return;
    const hold = held || this.heldThisHit;
    this.stats.hits++;
    this.stats.bestHold = Math.max(this.stats.bestHold, hold);
    this.current.hits++;
    this.run.hits++;
    if (outcome !== 'ghostLost') this.run.longestHold = Math.max(this.run.longestHold, Math.min(15, hold));
    if (outcome === 'exhaled' || outcome === 'rings') this.unlock('first_hit');
    this.combo = 0; this.heldThisHit = 0; this.tricksThisHit.clear();
    if (this.mode === 'local') {
      if (this.turn === this.players.length - 1) this.unlock('duo');
      this.turn = (this.turn + 1) % this.players.length;
      this.emit({ type: 'turn', player: this.turn });
    } else this.emit({ type: 'run', run: { ...this.run }, hitEnded: true });
    this.save();
  }

  resetStats(): void {
    this.stats = emptyStats();
    this.save();
  }

  save(): void {
    try { this.storage?.setItem(STATS_KEY, JSON.stringify(this.stats)); } catch { /* ignore */ }
  }
}
