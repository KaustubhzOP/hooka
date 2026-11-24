import { describe, it, expect, beforeEach } from 'vitest';
import { Machine, DEFAULT_MACHINE_CONFIG, type MachineEvent, type MachineInput, type MachineConfig } from '../src/machine';

const DT = 1 / 60;
const PURSED = 0.6;      // well above blowOn (0.35)
const RELAXED = 0.05;    // well below blowOn * 0.6
const neutral: MachineInput = { blow: RELAXED, jaw: 0, penNear: false, pinchOk: false };

let events: MachineEvent[];
let m: Machine;

function make(over: Partial<MachineConfig> = {}) {
  events = [];
  m = new Machine({ ...DEFAULT_MACHINE_CONFIG, ...over }, e => events.push(e));
}

/** Run the machine for `seconds` with a fixed input. */
function run(seconds: number, input: Partial<MachineInput>) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) m.step(DT, { ...neutral, ...input });
}

const transitions = () => events.filter(e => e.type === 'transition').map(e => (e as { to: string }).to);
const exhales = () => events.flatMap(e => (e.type === 'exhale' ? [e.exhale] : []));

/** pen at lips + pursed for `inhale` seconds, then relax with the pen still there. */
function inhaleThenHold(inhale = 2) {
  run(inhale, { penNear: true, blow: PURSED });
  run(0.4, { penNear: true, blow: RELAXED });
}

beforeEach(() => make());

describe('Machine', () => {
  it('starts idle', () => {
    expect(m.state).toBe('IDLE');
  });

  it('does nothing when blowing without the pen', () => {
    run(3, { blow: PURSED, penNear: false });
    expect(m.state).toBe('IDLE');
    expect(events).toHaveLength(0);
  });

  it('does nothing when the pen is at the lips but the lips are relaxed', () => {
    run(3, { penNear: true, blow: RELAXED });
    expect(m.state).toBe('IDLE');
  });

  it('needs the lips pursed for at least onDelay (120 ms) before inhaling', () => {
    run(0.08, { penNear: true, blow: PURSED });
    expect(m.state).toBe('IDLE');
    run(0.06, { penNear: true, blow: PURSED });
    expect(m.state).toBe('INHALING');
  });

  it('runs the normal inhale → hold → exhale → idle flow', () => {
    run(2, { penNear: true, blow: PURSED });
    expect(m.state).toBe('INHALING');
    expect(m.charge).toBeGreaterThan(1.7);

    run(0.4, { penNear: true, blow: RELAXED });            // relax lips ≥ 250 ms
    expect(m.state).toBe('HOLDING');
    const charge = m.charge;

    run(1, { penNear: false, blow: RELAXED });             // hold, pen away, mouth closed
    expect(m.state).toBe('HOLDING');

    run(0.2, { penNear: false, blow: PURSED });            // blow
    expect(m.state).toBe('EXHALING');
    const [ex] = exhales();
    expect(ex.kind).toBe('blow');
    expect(ex.duration).toBeCloseTo(1.0 + 0.6 * charge, 5);
    expect(ex.strength).toBeGreaterThan(0.3);

    run(ex.duration + 0.05, { blow: PURSED });
    expect(m.state).toBe('IDLE');
    expect(m.charge).toBe(0);
    expect(transitions()).toEqual(['INHALING', 'HOLDING', 'EXHALING', 'IDLE']);
  });

  it('caps the inhale charge at maxInhale', () => {
    run(7, { penNear: true, blow: PURSED });
    expect(m.state).toBe('INHALING');
    expect(m.charge).toBeCloseTo(DEFAULT_MACHINE_CONFIG.maxInhale, 5);
  });

  it('ends the inhale when the pen is pulled away for ≥ 350 ms', () => {
    run(1.5, { penNear: true, blow: PURSED });
    run(0.3, { penNear: false, blow: PURSED });
    expect(m.state).toBe('INHALING');
    run(0.1, { penNear: false, blow: PURSED });
    expect(m.state).toBe('HOLDING');
  });

  it('rejects a short inhale and goes back to IDLE', () => {
    run(0.3, { penNear: true, blow: PURSED });               // 0.12 s to start, ~0.18 s of charge
    expect(m.state).toBe('INHALING');
    run(0.4, { penNear: true, blow: RELAXED });
    expect(m.state).toBe('IDLE');
    expect(events.some(e => e.type === 'inhaleRejected')).toBe(true);
    expect(exhales()).toHaveLength(0);
  });

  it('does not exhale on a lingering pucker after the pen is pulled away', () => {
    run(2, { penNear: true, blow: PURSED });
    run(0.5, { penNear: false, blow: PURSED });              // pen away, lips still pursed
    expect(m.state).toBe('HOLDING');
    run(2, { penNear: false, blow: PURSED });                // pucker lingers: must not count as a blow
    expect(m.state).toBe('HOLDING');
    expect(exhales()).toHaveLength(0);

    run(0.2, { blow: RELAXED });                             // relax once…
    run(0.2, { blow: PURSED });                              // …then a real blow
    expect(m.state).toBe('EXHALING');
    expect(exhales()[0].kind).toBe('blow');
  });

  it('coughs the smoke out after maxHold seconds', () => {
    inhaleThenHold();
    expect(m.state).toBe('HOLDING');
    run(DEFAULT_MACHINE_CONFIG.maxHold - 0.6, { blow: RELAXED });
    expect(m.state).toBe('HOLDING');
    run(0.5, { blow: RELAXED });
    expect(m.state).toBe('EXHALING');
    expect(exhales()[0].kind).toBe('cough');
  });

  describe('ghost puff', () => {
    const WIDE = { blow: RELAXED, jaw: 0.7 };
    const ghostEvents = () => events.flatMap(e => (e.type === 'ghost' ? [e.phase] : []));

    it('opening the jaw wide while holding rolls out a ghost ball', () => {
      inhaleThenHold();
      run(0.2, WIDE);
      expect(m.state).toBe('HOLDING');
      run(0.15, WIDE);
      expect(m.state).toBe('GHOST');
      expect(ghostEvents()).toEqual(['out']);
    });

    it('a quick sip pulls the ghost back in and keeps the smoke', () => {
      inhaleThenHold(2);
      const charge = m.charge;
      run(0.4, WIDE);
      run(0.2, { blow: PURSED });
      expect(m.state).toBe('HOLDING');
      expect(ghostEvents()).toEqual(['out', 'in']);
      expect(m.charge).toBeCloseTo(charge, 5);
      run(0.5, { blow: PURSED });                           // the sip itself must not count as a blow
      expect(m.state).toBe('HOLDING');
    });

    it('the ghost floats away if it is not sipped back in time', () => {
      inhaleThenHold();
      run(0.4, WIDE);
      run(DEFAULT_MACHINE_CONFIG.ghostWindow + 0.1, { blow: RELAXED });
      expect(m.state).toBe('IDLE');
      expect(ghostEvents()).toEqual(['out', 'lost']);
      expect(events.some(e => e.type === 'hitEnd' && e.outcome === 'ghostLost')).toBe(true);
    });
  });

  describe('French inhale', () => {
    const FRENCH = { blow: RELAXED, jaw: 0.2, pitch: 0.4 };
    it('mouth slightly open + head tilted back starts the trick while holding', () => {
      inhaleThenHold();
      run(0.4, FRENCH);
      expect(m.state).toBe('HOLDING');
      expect(m.trick).toBe('french');
      run(0.4, { blow: RELAXED, jaw: 0.2, pitch: 0 });      // head back down ends it
      expect(m.trick).toBeNull();
      const t = events.filter(e => e.type === 'trick');
      expect(t.map(e => (e as { active: boolean }).active)).toEqual([true, false]);
    });

    it('needs the head tilted back', () => {
      inhaleThenHold();
      run(1, { blow: RELAXED, jaw: 0.2, pitch: 0.05 });
      expect(m.trick).toBeNull();
    });
  });

  it('reports the end of every hit (for turns in 2-player mode)', () => {
    inhaleThenHold();
    run(0.2, { blow: PURSED });
    run(5, { blow: RELAXED });
    expect(events.filter(e => e.type === 'hitEnd').map(e => (e as { outcome: string }).outcome)).toEqual(['exhaled']);
  });

  it('does not release a ghost when the jaw opens only a little', () => {
    inhaleThenHold();
    run(2, { blow: RELAXED, jaw: 0.3 });
    expect(m.state).toBe('HOLDING');
  });

  it('noisy O / sneer scores inside the hysteresis band do not flicker the gesture', () => {
    inhaleThenHold();
    run(0.3, { blow: 0.5, funnel: 0.6, jaw: 0.3 });           // O → ring 1
    run(0.3, { blow: 0.5, funnel: 0.3, jaw: 0.3 });           // dips just under the threshold, above 0.75×
    expect(events.filter(e => e.type === 'ring')).toHaveLength(1);
  });

  it('blocks the inhale without a pinch grip when requirePinch is on', () => {
    make({ requirePinch: true });
    run(2, { penNear: true, pinchOk: false, blow: PURSED });
    expect(m.state).toBe('IDLE');
    run(0.3, { penNear: true, pinchOk: true, blow: PURSED });
    expect(m.state).toBe('INHALING');
  });

  it('applies a cooldown after an exhale before a new inhale can start', () => {
    m.forceExhale('test', 0.9, 0);
    run(1.05, { blow: RELAXED });
    expect(m.state).toBe('IDLE');
    run(0.5, { penNear: true, blow: PURSED });               // still cooling down (0.8 s)
    expect(m.state).toBe('IDLE');
    run(0.5, { penNear: true, blow: PURSED });
    expect(m.state).toBe('INHALING');
  });

  it('uses hysteresis: a score between 0.6× and 1× the threshold keeps the current lip state', () => {
    run(1, { penNear: true, blow: PURSED });
    expect(m.state).toBe('INHALING');
    run(1, { penNear: true, blow: 0.3 });                    // 0.21 < 0.3 < 0.35: still pursed
    expect(m.state).toBe('INHALING');
    run(0.3, { penNear: true, blow: 0.15 });                 // below 0.21: relaxed
    expect(m.state).toBe('HOLDING');
  });

  describe('smoke rings', () => {
    const O = { blow: 0.5, funnel: 0.6, jaw: 0.3 };      // funnelled lips, jaw open
    const rings = () => events.filter(e => e.type === 'ring');

    it('puffs one ring per O-shaped mouth, using charge, without exhaling', () => {
      inhaleThenHold(2.5);
      const charge = m.charge;
      run(0.3, O);
      expect(rings()).toHaveLength(1);                       // held O = still one ring
      expect(m.state).toBe('HOLDING');
      expect(m.charge).toBeCloseTo(charge - DEFAULT_MACHINE_CONFIG.ringCost, 5);
      run(0.2, { blow: RELAXED });                           // close the mouth…
      run(0.2, O);                                           // …and make another O
      expect(rings()).toHaveLength(2);
      expect(exhales()).toHaveLength(0);
    });

    it('goes back to IDLE once the rings have used up the smoke', () => {
      inhaleThenHold(1.0);                                   // ~0.9 s charge → 1 ring, then empty
      run(0.3, O);
      run(0.2, { blow: RELAXED });
      run(0.3, O);
      expect(m.state).toBe('IDLE');
      expect(m.charge).toBe(0);
      expect(transitions().at(-1)).toBe('IDLE');
    });

    it('a lingering O after pulling the pen away does not puff a ring', () => {
      run(2, { penNear: true, ...O });
      run(0.5, { penNear: false, ...O });
      expect(m.state).toBe('HOLDING');
      run(1, O);
      expect(rings()).toHaveLength(0);
    });

    it('an O mouth never counts as a blow or a jaw leak', () => {
      inhaleThenHold(4);
      run(0.3, { blow: 0.6, funnel: 0.6, jaw: 0.6 });        // wide O
      expect(exhales()).toHaveLength(0);
      expect(rings()).toHaveLength(1);
    });
  });

  describe('nose exhale', () => {
    it('scrunching the nose while holding exhales through the nose', () => {
      inhaleThenHold();
      run(0.1, { blow: RELAXED, sneer: 0.6 });
      expect(m.state).toBe('HOLDING');
      run(0.1, { blow: RELAXED, sneer: 0.6 });
      expect(m.state).toBe('EXHALING');
      expect(exhales()[0].kind).toBe('nose');
    });

    it('a sneer does nothing outside HOLDING', () => {
      run(2, { blow: RELAXED, sneer: 0.9, penNear: true });
      expect(m.state).toBe('IDLE');
    });
  });

  it('forceExhale works from IDLE (test smoke)', () => {
    m.forceExhale();
    expect(m.state).toBe('EXHALING');
    expect(exhales()[0].kind).toBe('test');
  });
});
