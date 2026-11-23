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

export type GameEvent =
  | { type: 'unlock'; achievement: Achievement }
  | { type: 'points'; points: number; label: string; player: number }
  | { type: 'combo'; rings: number; best: boolean }
  | { type: 'turn'; player: number };

export const STATS_KEY = 'virtual-hookah.stats.v1';
const emptyStats = (): Stats => ({ bestRings: 0, totalRings: 0, bestHold: 0, bestScore: 0, hits: 0, flavours: [], unlocked: [] });

export class Game {
  stats: Stats;
  mode: 'solo' | 'duo' = 'solo';
  players: Player[] = [{ name: 'Player 1', score: 0, hits: 0, bestRings: 0 }, { name: 'Player 2', score: 0, hits: 0, bestRings: 0 }];
  turn = 0;
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

  get current(): Player { return this.players[this.mode === 'duo' ? this.turn : 0]; }

  setMode(mode: 'solo' | 'duo'): void {
    this.mode = mode;
    this.turn = 0;
    this.players.forEach(p => { p.score = 0; p.hits = 0; p.bestRings = 0; });
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
    this.stats.bestScore = Math.max(this.stats.bestScore, p.score);
    this.emit({ type: 'points', points, label, player: this.mode === 'duo' ? this.turn : 0 });
  }

  /** A ring was puffed; index = rings so far in this hit. */
  ring(index: number): void {
    this.combo = index;
    this.stats.totalRings++;
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
    this.stats.hits++;
    this.stats.bestHold = Math.max(this.stats.bestHold, held || this.heldThisHit);
    this.current.hits++;
    if (outcome === 'exhaled' || outcome === 'rings') this.unlock('first_hit');
    this.combo = 0; this.heldThisHit = 0; this.tricksThisHit.clear();
    if (this.mode === 'duo') {
      if (this.turn === 1) this.unlock('duo');
      this.turn = 1 - this.turn;
      this.emit({ type: 'turn', player: this.turn });
    }
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
