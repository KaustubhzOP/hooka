/**
 * Online match rules, as a pure reducer (no network, no DOM) so it can be
 * unit tested. Every client runs the same reducer on the same broadcast
 * events; the "authority" (the present member with the lowest seat) is the
 * only one that emits `start`, `turn` and `end`.
 *
 * Modes
 *  - pass: one player at a time holds the hookah; the hose passes after each hit.
 *          `rounds` = how many hits each player gets.
 *  - live: everyone plays at once for rounds × LIVE_ROUND_SECONDS.
 * Challenges decide the winner: total score, total rings, longest hold, tricks.
 */
import type { RunStats } from '../game';

export type MatchMode = 'pass' | 'live';
export type Challenge = 'score' | 'rings' | 'hold' | 'tricks';
export const LIVE_ROUND_SECONDS = 45;

export interface MatchState {
  phase: 'lobby' | 'playing' | 'finished';
  mode: MatchMode;
  challenge: Challenge;
  rounds: number;
  order: string[];            // user ids in turn order
  turn: number;               // index into order (pass mode)
  round: number;              // 1-based (pass mode)
  hitsThisTurn: number;
  startedAt: number;          // ms, authority clock
  endsAt: number;             // ms (live mode)
  stats: Record<string, RunStats>;
  left: string[];             // players who dropped out mid-game
}

export type MatchEvent =
  | { type: 'start'; mode: MatchMode; challenge: Challenge; rounds: number; order: string[]; at: number }
  | { type: 'stats'; user: string; run: RunStats }
  | { type: 'turnDone'; user: string }
  | { type: 'leave'; user: string }
  | { type: 'end' }
  | { type: 'reset' };

export const emptyStats = (): RunStats => ({ score: 0, rings: 0, bestCombo: 0, longestHold: 0, hits: 0, tricks: 0 });

export function initialMatch(): MatchState {
  return { phase: 'lobby', mode: 'pass', challenge: 'score', rounds: 3, order: [], turn: 0, round: 1, hitsThisTurn: 0,
           startedAt: 0, endsAt: 0, stats: {}, left: [] };
}

export function metric(c: Challenge, s: RunStats): number {
  switch (c) {
    case 'rings': return s.rings;
    case 'hold': return Math.round(s.longestHold * 10) / 10;
    case 'tricks': return s.tricks;
    default: return s.score;
  }
}

export const CHALLENGE_LABEL: Record<Challenge, string> = {
  score: 'Highest score', rings: 'Most rings', hold: 'Longest hold', tricks: 'Most tricks'
};

/** Who holds the hookah right now (pass mode), or null. */
export function activePlayer(m: MatchState): string | null {
  if (m.phase !== 'playing' || m.mode !== 'pass') return null;
  return m.order[m.turn] ?? null;
}

/** Can this user inhale right now? */
export function canPlay(m: MatchState, user: string, now: number): boolean {
  if (m.phase !== 'playing' || m.left.includes(user)) return false;
  if (m.mode === 'live') return now < m.endsAt;
  return activePlayer(m) === user;
}

/** Standings, best first, ties share a place. */
export function standings(m: MatchState): { user: string; value: number; place: number; stats: RunStats }[] {
  const rows = m.order.map(u => ({ user: u, stats: m.stats[u] ?? emptyStats(), value: metric(m.challenge, m.stats[u] ?? emptyStats()) }))
    .sort((a, b) => b.value - a.value || b.stats.score - a.stats.score);
  let place = 0, prev = NaN;
  return rows.map((r, i) => { if (r.value !== prev) { place = i + 1; prev = r.value; } return { ...r, place }; });
}

function advanceTurn(m: MatchState): MatchState {
  const n = m.order.length;
  let { turn, round } = m;
  for (let step = 0; step < n; step++) {
    turn++;
    if (turn >= n) { turn = 0; round++; }
    if (round > m.rounds) return { ...m, turn: 0, round: m.rounds, phase: 'finished', hitsThisTurn: 0 };
    if (!m.left.includes(m.order[turn])) return { ...m, turn, round, hitsThisTurn: 0 };
  }
  return { ...m, phase: 'finished' };
}

export function reduce(m: MatchState, e: MatchEvent): MatchState {
  switch (e.type) {
    case 'start': {
      const order = [...new Set(e.order)];
      if (order.length < 2) return m;
      return {
        ...initialMatch(), phase: 'playing', mode: e.mode, challenge: e.challenge,
        rounds: Math.max(1, Math.min(10, e.rounds)), order, startedAt: e.at,
        endsAt: e.mode === 'live' ? e.at + Math.max(1, Math.min(10, e.rounds)) * LIVE_ROUND_SECONDS * 1000 : 0,
        stats: Object.fromEntries(order.map(u => [u, emptyStats()]))
      };
    }
    case 'stats': {
      if (m.phase === 'lobby' || !m.order.includes(e.user)) return m;
      return { ...m, stats: { ...m.stats, [e.user]: { ...e.run } } };
    }
    case 'turnDone': {
      if (m.phase !== 'playing' || m.mode !== 'pass' || activePlayer(m) !== e.user) return m;
      return advanceTurn(m);
    }
    case 'leave': {
      if (m.phase !== 'playing' || !m.order.includes(e.user) || m.left.includes(e.user)) return m;
      const next = { ...m, left: [...m.left, e.user] };
      if (m.order.length - next.left.length < 2) return { ...next, phase: 'finished' };
      return m.mode === 'pass' && activePlayer(m) === e.user ? advanceTurn(next) : next;
    }
    case 'end':
      return m.phase === 'playing' ? { ...m, phase: 'finished' } : m;
    case 'reset':
      return { ...initialMatch(), mode: m.mode, challenge: m.challenge, rounds: m.rounds };
  }
}

/** The authority: the present member with the lowest seat. Everyone computes the same answer. */
export function authority(present: { user_id: string; seat: number }[]): string | null {
  return [...present].sort((a, b) => a.seat - b.seat)[0]?.user_id ?? null;
}
