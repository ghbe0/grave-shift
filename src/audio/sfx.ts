// Procedural sound effects with the Web Audio API: no audio files to download.
export class Sfx {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.5;

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
      const n = (this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate));
      const d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch { this.ctx = null; }
  }

  private env(gain: number, dur: number): GainNode | null {
    const c = this.ctx;
    if (!c || c.state !== 'running') return null;
    const g = c.createGain();
    g.gain.setValueAtTime(gain * this.volume, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    g.connect(c.destination);
    return g;
  }
  private burst(gain: number, dur: number, cutoff: number, type: BiquadFilterType = 'lowpass'): void {
    const g = this.env(gain, dur);
    if (!g || !this.ctx || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loopStart = Math.random() * 0.5;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff;
    src.connect(f).connect(g);
    src.start(0, Math.random() * 0.5, dur);
  }
  private tone(freq: number, to: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    const g = this.env(gain, dur);
    if (!g || !this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, this.ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), this.ctx.currentTime + dur);
    o.connect(g);
    o.start();
    o.stop(this.ctx.currentTime + dur);
  }

  shot(heavy: number, distant = false): void {
    const k = distant ? 0.35 : 1;
    this.burst(0.5 * k, 0.12 + heavy * 0.12, 1800 - heavy * 900);
    this.tone(220 - heavy * 90, 50, 0.1 + heavy * 0.08, 0.45 * k, 'triangle');
  }
  energy(): void { this.tone(900, 120, 0.25, 0.35, 'sawtooth'); this.burst(0.2, 0.2, 3000, 'highpass'); }
  dry(): void { this.tone(1400, 900, 0.03, 0.15, 'square'); }
  reload(): void { this.burst(0.2, 0.05, 2500, 'highpass'); setTimeout(() => this.burst(0.25, 0.06, 1500), 220); }
  hit(kill: boolean): void { this.tone(kill ? 1300 : 900, kill ? 700 : 600, 0.07, 0.22, 'square'); }
  hurt(): void { this.tone(160, 60, 0.25, 0.5, 'sawtooth'); }
  jump(): void { this.burst(0.12, 0.08, 500); }
  land(): void { this.burst(0.25, 0.1, 300); }
  thrust(): void { this.burst(0.3, 0.35, 900, 'bandpass'); this.tone(180, 320, 0.3, 0.12, 'sawtooth'); }
  slide(): void { this.burst(0.25, 0.5, 700, 'bandpass'); }
  explode(): void { this.burst(0.9, 0.7, 500); this.tone(90, 30, 0.6, 0.6); }
  buy(): void { this.tone(660, 660, 0.08, 0.25); setTimeout(() => this.tone(990, 990, 0.14, 0.25), 80); }
  deny(): void { this.tone(180, 140, 0.18, 0.3, 'square'); }
  round(): void { [220, 277, 330].forEach((f, i) => setTimeout(() => this.tone(f, f * 0.99, 0.7, 0.25, 'sawtooth'), i * 160)); }
  powerup(): void { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, f, 0.15, 0.22), i * 70)); }
  groan(): void { this.tone(90 + Math.random() * 40, 55, 0.5, 0.18, 'sawtooth'); }
}
