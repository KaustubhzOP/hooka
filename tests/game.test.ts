import { describe, it, expect } from 'vitest';
import { Game, STATS_KEY, type GameEvent } from '../src/game';
import { Coals } from '../src/hookah';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('game', () => {
  it('scores ring combos, tracks the best and unlocks ring achievements', () => {
    const events: GameEvent[] = [];
    const g = new Game(mem(), e => events.push(e));
    for (let i = 1; i <= 5; i++) g.ring(i);
    expect(g.stats.bestRings).toBe(5);
    expect(g.current.score).toBe(15 * (1 + 2 + 3 + 4 + 5));
    expect(g.stats.unlocked).toEqual(expect.arrayContaining(['first_ring', 'combo3', 'combo5']));
    expect(events.filter(e => e.type === 'unlock')).toHaveLength(3);
  });

  it('scores a trick only once per hit, and coughing costs points', () => {
    const g = new Game(null);
    g.trick('french'); g.trick('french');
    expect(g.current.score).toBe(15);
    g.exhale('cough', 6);
    expect(g.current.score).toBe(10);
    expect(g.stats.unlocked).toContain('rookie');
    g.hitEnd('exhaled', 6);
    g.trick('french');
    expect(g.current.score).toBe(25);
  });

  it('passes the turn between 3 players on one device', () => {
    const g = new Game(null);
    g.setMode('local', 3);
    expect(g.players).toHaveLength(3);
    for (const expected of [1, 2, 0]) { g.exhale('blow', 1); g.hitEnd('exhaled', 1); expect(g.turn).toBe(expected); }
    expect(g.stats.unlocked).toContain('duo');
  });

  it('tracks the run for leaderboard submission', () => {
    const g = new Game(null);
    g.ring(1); g.ring(2); g.trick('french'); g.exhale('blow', 4.2); g.hitEnd('exhaled', 4.2);
    expect(g.run).toEqual({ score: 15 + 30 + 15 + 10 + 13, rings: 2, bestCombo: 2, longestHold: 4.2, hits: 1, tricks: 1 });
    g.resetRun();
    expect(g.run.score).toBe(0);
    expect(g.current.score).toBe(0);
  });

  it('passes the turn in 2-player mode', () => {
    const events: GameEvent[] = [];
    const g = new Game(null, e => events.push(e));
    g.setMode('local', 2);
    g.exhale('blow', 2);
    g.hitEnd('exhaled', 2);
    expect(g.turn).toBe(1);
    g.ring(1);
    g.hitEnd('rings', 1);
    expect(g.turn).toBe(0);
    expect(g.players[0].score).toBe(16);
    expect(g.players[1].score).toBe(15);
    expect(g.stats.unlocked).toContain('duo');
    g.hitEnd('rejected', 0);                                 // a rejected inhale keeps the turn
    expect(g.turn).toBe(0);
  });

  it('persists stats and unlocks the flavour explorer after 5 flavours', () => {
    const s = mem();
    const g = new Game(s);
    ['a', 'b', 'c', 'd', 'e'].forEach(f => g.flavour(f));
    expect(g.stats.unlocked).toContain('explorer');
    expect(new Game(s).stats.flavours).toHaveLength(5);
    expect(s.m.has(STATS_KEY)).toBe(true);
  });
});

describe('coals', () => {
  it('cool down while pulling, and flipping brings the heat back', () => {
    const c = new Coals();
    for (let i = 0; i < 600; i++) c.burn(1 / 30, true, 1);    // 20 s of pulling
    expect(c.heat).toBeLessThan(0.4);
    expect(c.needsFlip).toBe(true);
    expect(c.flip()).toBe(true);
    expect(c.heat).toBeGreaterThan(0.8);
    expect(c.ash).toBe(0);
  });

  it('burn out when the fuel is gone, and fresh coals reset them', () => {
    const c = new Coals();
    c.fuel = 0.001;
    for (let i = 0; i < 300; i++) c.burn(1 / 30, true, 1.5);
    expect(c.burntOut).toBe(true);
    expect(c.flip()).toBe(false);
    c.fresh();
    expect(c.heat).toBe(1);
  });
});
