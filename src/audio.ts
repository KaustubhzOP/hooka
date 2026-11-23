/**
 * Procedural sound with the Web Audio API — no audio files.
 *  - bubbling: short rising sine "blips" + a gurgling noise bed, rate/pitch follow the inhale charge
 *  - whoosh: band-passed noise whose gain follows the exhale intensity
 *  - cough: a few sharp noise bursts with a low voiced body
 */

export class HookahAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private bedGain!: GainNode;
  private bedFilter!: BiquadFilterNode;
  private whooshGain!: GainNode;
  private whooshFilter!: BiquadFilterNode;
  private blipAcc = 0;
  private _muted = false;

  get muted() { return this._muted; }
  get started() { return !!this.ctx; }

  /** Must be called from a user gesture (click / key) the first time. */
  ensure(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = this.ctx = new Ctor();
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // 2 s of white noise, shared by all noise sources
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // gurgle bed: low-passed noise, amplitude-wobbled by an LFO
    this.bedFilter = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' });
    this.bedFilter.frequency.value = 280; this.bedFilter.Q.value = 6;
    this.bedGain = ctx.createGain(); this.bedGain.gain.value = 0;
    const wobble = ctx.createGain(); wobble.gain.value = 0.6;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.4;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 7; lfo.connect(lfoDepth).connect(wobble.gain);
    this.loopNoise().connect(this.bedFilter).connect(wobble).connect(this.bedGain).connect(this.master);
    lfo.start();

    // exhale whoosh
    this.whooshFilter = Object.assign(ctx.createBiquadFilter(), { type: 'bandpass' });
    this.whooshFilter.frequency.value = 900; this.whooshFilter.Q.value = 0.6;
    const hiCut = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' });
    hiCut.frequency.value = 3500;
    this.whooshGain = ctx.createGain(); this.whooshGain.gain.value = 0;
    this.loopNoise().connect(this.whooshFilter).connect(hiCut).connect(this.whooshGain).connect(this.master);
  }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.03);
  }

  /**
   * Call every frame.
   * @param bubbling 0…1 inhale intensity (0 = silent)
   * @param pitch    0…1 inhale charge fraction (raises bubble pitch)
   * @param whoosh   0…1 exhale intensity
   */
  update(dt: number, bubbling: number, pitch: number, whoosh: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    this.bedGain.gain.setTargetAtTime(bubbling * 0.35, now, 0.08);
    this.bedFilter.frequency.setTargetAtTime(220 + 260 * pitch, now, 0.1);
    this.whooshGain.gain.setTargetAtTime(whoosh * 0.5, now, 0.06);
    this.whooshFilter.frequency.setTargetAtTime(600 + 900 * whoosh, now, 0.08);

    if (bubbling > 0.01) {
      this.blipAcc += dt * (6 + 26 * bubbling) * (0.4 + Math.random() * 1.2);
      while (this.blipAcc >= 1) {
        this.blipAcc -= 1;
        this.blip(now + Math.random() * 0.05, pitch, bubbling);
      }
    } else this.blipAcc = 0;
  }

  /** One bubble: a sine with a fast upward pitch sweep and a short envelope. */
  private blip(at: number, pitch: number, level: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f0 = (160 + Math.random() * 280) * (1 + 0.5 * pitch);
    const dur = 0.04 + Math.random() * 0.06;
    osc.frequency.setValueAtTime(f0, at);
    osc.frequency.exponentialRampToValueAtTime(f0 * (1.8 + Math.random()), at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.08 + 0.12 * level, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(this.master);
    osc.start(at); osc.stop(at + dur + 0.02);
  }

  /** A short coughing fit: 3 bursts. */
  cough(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + 0.02;
    [0, 0.3, 0.55].forEach((off, i) => {
      const at = t0 + off, amp = [0.9, 0.7, 0.5][i];
      const src = ctx.createBufferSource(); src.buffer = this.noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.2;
      const bp = Object.assign(ctx.createBiquadFilter(), { type: 'bandpass' });
      bp.frequency.value = 450 + Math.random() * 200; bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(amp, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      src.connect(bp).connect(g).connect(this.master);
      src.start(at, Math.random()); src.stop(at + 0.25);

      // voiced body
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, at); osc.frequency.exponentialRampToValueAtTime(95, at + 0.18);
      const lp = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' }); lp.frequency.value = 700;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, at);
      og.gain.exponentialRampToValueAtTime(amp * 0.25, at + 0.015);
      og.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(lp).connect(og).connect(this.master);
      osc.start(at); osc.stop(at + 0.2);
    });
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise; src.loop = true; src.start();
    return src;
  }
}
