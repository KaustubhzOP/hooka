import { describe, it, expect } from 'vitest';
import { reduce, initialMatch, activePlayer, canPlay, standings, authority, LIVE_ROUND_SECONDS, type MatchState } from '../src/online/match';
import { emptyRun } from '../src/game';

const start = (mode: 'pass' | 'live', rounds = 2, order = ['a', 'b', 'c']): MatchState =>
  reduce(initialMatch(), { type: 'start', mode, challenge: 'rings', rounds, order, at: 1000 });

describe('online match', () => {
  it('needs at least 2 players', () => {
    expect(reduce(initialMatch(), { type: 'start', mode: 'pass', challenge: 'score', rounds: 1, order: ['a'], at: 0 }).phase).toBe('lobby');
  });

  it('passes the hookah around for the given rounds, then finishes', () => {
    let m = start('pass', 2);
    const seen: string[] = [];
    while (m.phase === 'playing') {
      const p = activePlayer(m)!;
      seen.push(`${m.round}${p}`);
      expect(canPlay(m, p, 0)).toBe(true);
      expect(canPlay(m, p === 'a' ? 'b' : 'a', 0)).toBe(false);
      m = reduce(m, { type: 'turnDone', user: p });
    }
    expect(seen).toEqual(['1a', '1b', '1c', '2a', '2b', '2c']);
    expect(m.phase).toBe('finished');
  });

  it('ignores turnDone from someone who does not hold the hookah', () => {
    const m = start('pass');
    expect(reduce(m, { type: 'turnDone', user: 'b' })).toBe(m);
  });

  it('skips players who leave, and ends when fewer than 2 remain', () => {
    let m = start('pass', 1);
    m = reduce(m, { type: 'leave', user: 'a' });         // a held the hookah → passes to b
    expect(activePlayer(m)).toBe('b');
    m = reduce(m, { type: 'turnDone', user: 'b' });
    expect(activePlayer(m)).toBe('c');
    m = reduce(m, { type: 'leave', user: 'b' });
    expect(m.phase).toBe('finished');
  });

  it('live mode: everyone plays until the timer runs out', () => {
    const m = start('live', 2);
    expect(m.endsAt).toBe(1000 + 2 * LIVE_ROUND_SECONDS * 1000);
    expect(canPlay(m, 'a', 2000) && canPlay(m, 'c', 2000)).toBe(true);
    expect(canPlay(m, 'a', m.endsAt + 1)).toBe(false);
    expect(reduce(m, { type: 'end' }).phase).toBe('finished');
  });

  it('ranks by the challenge metric with shared places for ties', () => {
    let m = start('live');
    m = reduce(m, { type: 'stats', user: 'a', run: { ...emptyRun(), rings: 4, score: 100 } });
    m = reduce(m, { type: 'stats', user: 'b', run: { ...emptyRun(), rings: 7, score: 50 } });
    m = reduce(m, { type: 'stats', user: 'c', run: { ...emptyRun(), rings: 4, score: 100 } });
    m = reduce(m, { type: 'stats', user: 'zz', run: { ...emptyRun(), rings: 99 } });   // not in the match
    expect(standings(m).map(r => [r.user, r.place])).toEqual([['b', 1], ['a', 2], ['c', 2]]);
  });

  it('the authority is the present member with the lowest seat', () => {
    expect(authority([{ user_id: 'x', seat: 3 }, { user_id: 'y', seat: 1 }])).toBe('y');
    expect(authority([])).toBeNull();
  });
});
