// Sound, synthesised with the Web Audio API (no audio files to download).
//
// A gunshot is built the way a recorded one breaks down: a very short broadband crack, a distorted
// mid-range body, a low thump from the muzzle blast, the click of the action cycling, and a tail
// of echo from the surroundings. Each weapon class has its own balance of those layers.
// Everything runs through a compressor so rapid fire stays punchy instead of clipping.

/** How one class of weapon sounds. Gains are relative; times in seconds; frequencies in hertz. */
interface Voice {
  crack: number;
  body: number;
  bodyFreq: number;
  bodyTime: number;
  thump: number;
  thumpFreq: number;
  thumpTime: number;
  /** Echo sent to the reverb. */
  tail: number;
  /** Mechanical action noise after the shot. */
  action: number;
}

// By weapon class (`catalog.rs` C_*): pistol, SMG, rifle, shotgun, LMG, sniper, special, launcher.
const VOICES: Voice[] = [
  { crack: 0.9, body: 0.75, bodyFreq: 1500, bodyTime: 0.09, thump: 0.6, thumpFreq: 170, thumpTime: 0.09, tail: 0.3, action: 0.35 },
  { crack: 0.8, body: 0.7, bodyFreq: 1900, bodyTime: 0.07, thump: 0.45, thumpFreq: 190, thumpTime: 0.07, tail: 0.22, action: 0.3 },
  { crack: 1.0, body: 0.9, bodyFreq: 1250, bodyTime: 0.11, thump: 0.8, thumpFreq: 140, thumpTime: 0.11, tail: 0.38, action: 0.3 },
  { crack: 0.9, body: 1.15, bodyFreq: 750, bodyTime: 0.2, thump: 1.15, thumpFreq: 95, thumpTime: 0.2, tail: 0.55, action: 0.0 },
  { crack: 1.0, body: 1.0, bodyFreq: 1000, bodyTime: 0.12, thump: 0.95, thumpFreq: 120, thumpTime: 0.13, tail: 0.42, action: 0.4 },
  { crack: 1.2, body: 1.1, bodyFreq: 850, bodyTime: 0.24, thump: 1.25, thumpFreq: 85, thumpTime: 0.26, tail: 0.85, action: 0.0 },
  { crack: 0.9, body: 0.9, bodyFreq: 1200, bodyTime: 0.12, thump: 0.8, thumpFreq: 130, thumpTime: 0.12, tail: 0.4, action: 0.2 },
  { crack: 0.5, body: 1.0, bodyFreq: 500, bodyTime: 0.3, thump: 1.2, thumpFreq: 80, thumpTime: 0.3, tail: 0.6, action: 0.0 },
];

export interface ShotOptions { cls: number; distant?: boolean; suppressed?: boolean }

export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private out: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private drive: Float32Array<ArrayBuffer> | null = null;
  private _volume = 0.5;

  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = v; if (this.out && this.ctx) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    try {
      const c = (this.ctx = new AudioContext());
      const rate = c.sampleRate;
      // Two seconds of white noise, shared by every sound.
      const n = (this.noise = c.createBuffer(1, rate * 2, rate));
      const d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      // Mix bus: compressor, then the volume control.
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
      this.out = c.createGain();
      this.out.gain.value = this._volume;
      comp.connect(this.out).connect(c.destination);
      this.bus = comp;
      // Reverb: the echo of a yard between concrete walls. Early slaps, then a darkening decay.
      const len = Math.floor(rate * 1.7);
      const ir = c.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const w = ir.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          lp += (Math.random() * 2 - 1 - lp) * (0.55 - 0.45 * t); // high frequencies die first
          w[i] = lp * Math.pow(1 - t, 3.2) * 0.9;
        }
        for (const [ms, g] of [[23, 0.5], [41, 0.38], [67, 0.3], [97, 0.2]]) w[Math.floor(rate * (ms + ch * 5) / 1000)] += g * (ch ? -1 : 1);
      }
      this.reverb = c.createConvolver();
      this.reverb.buffer = ir;
      this.reverb.connect(comp);
      // Soft-clipping curve for the body of a shot.
      this.drive = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i / 511.5 - 1) * 5; this.drive[i] = Math.tanh(x); }
    } catch { this.ctx = null; }
  }
  private bus: AudioNode | null = null;

  private ready(): AudioContext | null {
    const c = this.ctx;
    return c && c.state === 'running' && this.bus && this.noise ? c : null;
  }

  /** A gain node with an attack/decay envelope, connected to the mix (and optionally the reverb). */
  private env(c: AudioContext, at: number, peak: number, attack: number, decay: number, wet = 0): GainNode {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(this.bus!);
    if (wet > 0 && this.reverb) {
      const send = c.createGain();
      send.gain.value = wet;
      g.connect(send).connect(this.reverb);
    }
    return g;
  }
  /** Filtered noise burst. */
  private hiss(c: AudioContext, at: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, wet = 0, shaped = false, sweepTo = 0): void {
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, at); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + attack + decay);
    let node: AudioNode = src.connect(f);
    if (shaped && this.drive) {
      const ws = c.createWaveShaper();
      ws.curve = this.drive;
      node = node.connect(ws);
    }
    node.connect(this.env(c, at, peak, attack, decay, wet));
    src.start(at, Math.random() * 1.2, attack + decay + 0.05);
  }
  /** Pitched tone that slides from `from` to `to`. */
  private tone(c: AudioContext, at: number, type: OscillatorType, from: number, to: number, peak: number, attack: number, decay: number, wet = 0): void {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), at + attack + decay);
    o.connect(this.env(c, at, peak, attack, decay, wet));
    o.start(at);
    o.stop(at + attack + decay + 0.05);
  }
  /** A short metallic tick: two detuned square partials through a band-pass. */
  private click(c: AudioContext, at: number, freq: number, peak: number, decay = 0.025): void {
    this.hiss(c, at, 'bandpass', freq, 6, peak, 0.001, decay);
    this.tone(c, at, 'square', freq * 0.52, freq * 0.5, peak * 0.25, 0.001, decay * 0.8);
  }

  /** One gunshot. */
  shot(o: ShotOptions): void {
    const c = this.ready();
    if (!c) return;
    const v = VOICES[o.cls] ?? VOICES[2];
    const t = c.currentTime + 0.001;
    // No two shots are identical.
    const vary = 0.94 + Math.random() * 0.12;
    if (o.distant) {
      // Far away the crack is gone: a dull report and a long echo.
      const g = 0.5;
      this.hiss(c, t, 'lowpass', 900 * vary, 0.7, v.body * g, 0.004, v.bodyTime * 1.6, v.tail * 1.4, true);
      this.tone(c, t, 'sine', v.thumpFreq * vary, v.thumpFreq * 0.4, v.thump * g * 0.8, 0.004, v.thumpTime * 1.4, v.tail);
      return;
    }
    if (o.suppressed) {
      // A suppressor swallows the crack and the low blast; what is left is a sharp cough and the action.
      this.hiss(c, t, 'bandpass', 2600 * vary, 0.9, 0.5, 0.002, 0.05, 0.05, true);
      this.hiss(c, t, 'lowpass', 500, 0.7, 0.35, 0.002, 0.07);
      this.click(c, t + 0.03, 3300 * vary, 0.22);
      return;
    }
    this.hiss(c, t, 'highpass', 3200, 0.5, v.crack, 0.0006, 0.022, v.tail * 0.5);
    this.hiss(c, t, 'bandpass', v.bodyFreq * vary, 0.8, v.body, 0.001, v.bodyTime, v.tail, true, v.bodyFreq * 0.45);
    this.hiss(c, t, 'lowpass', 380, 0.7, v.body * 0.7, 0.002, v.bodyTime * 1.3, v.tail * 0.6, true);
    this.tone(c, t, 'sine', v.thumpFreq * vary * 1.9, v.thumpFreq * 0.42, v.thump, 0.001, v.thumpTime, v.tail * 0.5);
    if (v.action > 0) {
      this.click(c, t + 0.035, 2900 * vary, v.action * 0.3);
      this.click(c, t + 0.06, 2100 * vary, v.action * 0.22);
    }
  }
  /** Pump, bolt or lever worked by hand after a shot. */
  cycle(cls: number): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime + (cls === 5 ? 0.32 : 0.22);
    this.click(c, t, 1500, 0.3, 0.04);
    this.hiss(c, t + 0.02, 'bandpass', 900, 2, 0.16, 0.01, 0.07);
    this.click(c, t + 0.16, 1900, 0.34, 0.04);
  }
  /** Rocket launch: a thump from the tube, then the motor tearing away. */
  rocket(distant = false): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime, g = distant ? 0.45 : 1;
    this.tone(c, t, 'sine', 150, 45, 0.9 * g, 0.003, 0.22, 0.4);
    this.hiss(c, t, 'bandpass', 700, 0.6, 0.8 * g, 0.004, 0.14, 0.5, true);
    this.hiss(c, t + 0.03, 'bandpass', 1400, 0.8, 0.5 * g, 0.05, 0.8, 0.35, true, 380);
  }
  /** Energy weapons: a discharge with a crackling edge. */
  energy(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, t, 'sawtooth', 1400, 110, 0.4, 0.002, 0.22, 0.3);
    this.tone(c, t, 'square', 90, 50, 0.4, 0.002, 0.16);
    this.hiss(c, t, 'highpass', 4500, 0.5, 0.4, 0.001, 0.12, 0.3);
    this.hiss(c, t + 0.05, 'bandpass', 2400, 5, 0.25, 0.005, 0.18, 0.2);
  }
  dry(): void {
    const c = this.ready();
    if (c) this.click(c, c.currentTime, 2500, 0.3, 0.02);
  }
  /** Magazine out, magazine in, action released, spread over the reload time. */
  reload(seconds = 2): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime, d = Math.max(0.9, seconds);
    this.click(c, t + d * 0.08, 1300, 0.3, 0.035);
    this.hiss(c, t + d * 0.1, 'bandpass', 600, 1.5, 0.2, 0.01, 0.12);
    this.hiss(c, t + d * 0.5, 'bandpass', 800, 1.5, 0.22, 0.01, 0.08);
    this.click(c, t + d * 0.55, 1700, 0.36, 0.04);
    this.click(c, t + d * 0.82, 1500, 0.4, 0.03);
    this.click(c, t + d * 0.86, 2600, 0.36, 0.035);
  }
  /** Hit confirmation: a dry tick, lower and doubled for a kill. */
  hit(kill: boolean): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.click(c, t, kill ? 1500 : 2300, 0.28, 0.02);
    if (kill) { this.click(c, t + 0.06, 1100, 0.3, 0.035); this.tone(c, t, 'sine', 180, 90, 0.3, 0.002, 0.09); }
  }
  /** Taking damage: a dull body blow. */
  hurt(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, t, 'sine', 130, 55, 0.7, 0.003, 0.16);
    this.hiss(c, t, 'lowpass', 700, 0.7, 0.45, 0.003, 0.09, 0, true);
  }
  /** Boots: a soft scuff. */
  jump(): void {
    const c = this.ready();
    if (c) this.hiss(c, c.currentTime, 'bandpass', 420, 0.8, 0.22, 0.008, 0.09);
  }
  land(): void {
    const c = this.ready();
    if (!c) return;
    this.tone(c, c.currentTime, 'sine', 110, 50, 0.45, 0.003, 0.1);
    this.hiss(c, c.currentTime, 'lowpass', 600, 0.7, 0.3, 0.003, 0.1);
  }
  thrust(): void {
    const c = this.ready();
    if (!c) return;
    this.hiss(c, c.currentTime, 'bandpass', 500, 0.7, 0.4, 0.03, 0.35, 0.1, true, 1500);
    this.tone(c, c.currentTime, 'sawtooth', 70, 120, 0.15, 0.03, 0.3);
  }
  slide(): void {
    const c = this.ready();
    if (c) this.hiss(c, c.currentTime, 'bandpass', 900, 0.6, 0.3, 0.03, 0.5, 0, false, 350);
  }
  /** Explosion: the crack of the charge, a deep boom, then debris and a long echo. */
  explode(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.hiss(c, t, 'highpass', 2000, 0.5, 0.9, 0.001, 0.05, 0.6);
    this.tone(c, t, 'sine', 120, 28, 1.3, 0.004, 0.7, 0.5);
    this.hiss(c, t, 'lowpass', 500, 0.7, 1.1, 0.004, 0.55, 0.9, true, 120);
    this.hiss(c, t + 0.12, 'bandpass', 1800, 0.7, 0.3, 0.08, 0.9, 0.4, false, 500);
    for (let k = 0; k < 5; k++) this.click(c, t + 0.25 + Math.random() * 0.7, 900 + Math.random() * 1500, 0.1 + Math.random() * 0.1, 0.03);
  }
  /** A purchase: something heavy and metal locks into place. */
  buy(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.click(c, t, 1200, 0.35, 0.04);
    this.click(c, t + 0.09, 1800, 0.4, 0.05);
    this.tone(c, t + 0.09, 'sine', 240, 160, 0.3, 0.003, 0.12, 0.2);
  }
  deny(): void {
    const c = this.ready();
    if (!c) return;
    this.tone(c, c.currentTime, 'square', 110, 95, 0.25, 0.003, 0.12);
    this.click(c, c.currentTime, 700, 0.2, 0.03);
  }
  /** A new round: a low horn swelling over a drum hit. */
  round(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, t, 'sine', 70, 40, 0.9, 0.005, 0.6, 0.5);
    for (const [f, g] of [[98, 0.3], [147, 0.22], [196, 0.14]]) this.tone(c, t + 0.05, 'sawtooth', f, f * 0.98, g, 0.5, 1.3, 0.5);
    this.hiss(c, t, 'lowpass', 300, 0.7, 0.5, 0.005, 0.4, 0.6, true);
  }
  powerup(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime;
    this.tone(c, t, 'sine', 220, 440, 0.3, 0.02, 0.35, 0.4);
    this.tone(c, t + 0.04, 'triangle', 330, 660, 0.2, 0.02, 0.4, 0.4);
    this.hiss(c, t, 'highpass', 5000, 0.5, 0.12, 0.05, 0.4, 0.3);
  }
  /** The dead: a rasping, wavering moan. */
  groan(): void {
    const c = this.ready();
    if (!c) return;
    const t = c.currentTime, f = 70 + Math.random() * 35;
    this.tone(c, t, 'sawtooth', f, f * 0.7, 0.16, 0.15, 0.7, 0.35);
    this.tone(c, t, 'sawtooth', f * 1.51, f * 1.02, 0.08, 0.2, 0.6, 0.3);
    this.hiss(c, t, 'bandpass', 650 + Math.random() * 300, 3, 0.14, 0.15, 0.6, 0.3);
  }
}
