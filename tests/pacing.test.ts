import { describe, expect, it } from 'vitest';
import { frameRateOptions, FrameLimiter, FrameMeter, isFpsLimit } from '../src/engine/pacing';

/** Simulates a display calling back at `hz` for `secs`, returning how many frames were drawn. */
function run(hz: number, limit: number, secs = 2, jitter = 0.2): number {
  const lim = new FrameLimiter(limit);
  let drawn = 0;
  for (let i = 0; i < hz * secs; i++) {
    const now = (i * 1000) / hz + (Math.sin(i * 12.9898) * jitter);
    if (lim.shouldRender(now)) drawn++;
  }
  return drawn / secs;
}

describe('frame limiter', () => {
  it('draws every refresh when uncapped, at any display rate', () => {
    for (const hz of [60, 144, 240, 360]) expect(run(hz, 0)).toBe(hz);
  });
  it('holds the cap on a faster display', () => {
    for (const [hz, cap] of [[360, 144], [360, 240], [360, 60], [240, 144], [144, 60], [360, 165]]) {
      expect(Math.abs(run(hz, cap, 4) - cap)).toBeLessThanOrEqual(1.5);
    }
  });
  it('never exceeds the display, and a cap above it changes nothing', () => {
    expect(run(144, 360)).toBe(144);
    expect(run(60, 240)).toBe(60);
  });
  it('resyncs after a stall instead of bursting to catch up', () => {
    const lim = new FrameLimiter(60);
    expect(lim.shouldRender(0)).toBe(true);
    expect(lim.shouldRender(2000)).toBe(true);
    // Straight after the stall, the next refresh at 360 Hz is too early.
    expect(lim.shouldRender(2002.8)).toBe(false);
  });
});

describe('frame meter', () => {
  it('measures rendered fps and detects the display refresh rate', () => {
    const m = new FrameMeter();
    for (let i = 0; i < 360; i++) {
      const now = (i * 1000) / 360;
      m.refresh(now);
      if (i % 2 === 0) m.rendered(now);
    }
    expect(m.displayHz).toBe(360);
    expect(Math.round(m.fps)).toBe(180);
    expect(m.frameMs).toBeCloseTo(1000 / 180, 1);
  });
  it('snaps near-misses to common panel rates', () => {
    const m = new FrameMeter();
    for (let i = 0; i < 100; i++) m.refresh(i * 6.97); // ~143.5 Hz
    expect(m.displayHz).toBe(144);
  });
});

describe('frame rate options', () => {
  it('default to the display rate and only offer caps below it', () => {
    const opts = frameRateOptions(144);
    expect(opts[0]).toEqual({ value: 0, label: '144 fps (matches your 144 Hz display)' });
    expect(opts.map(o => o.value)).toEqual([0, 30, 60, 75, 90, 100, 120]);
    expect(frameRateOptions(360).map(o => o.value)).toContain(300);
    expect(frameRateOptions(360).map(o => o.value)).not.toContain(360);
    expect(frameRateOptions(500).map(o => o.value)).toContain(480);
  });
  it('keep a saved cap that the current display cannot reach, marked as such', () => {
    const opts = frameRateOptions(60, 240);
    expect(opts.at(-1)).toEqual({ value: 240, label: '240 fps (above this 60 Hz display)' });
  });
  it('offer everything up to 360 while the rate is still being measured', () => {
    const opts = frameRateOptions(0);
    expect(opts[0].label).toMatch(/measuring/);
    expect(opts.at(-1)!.value).toBe(360);
  });
  it('validate saved values', () => {
    expect(isFpsLimit(0) && isFpsLimit(144) && isFpsLimit(360)).toBe(true);
    expect(isFpsLimit(143) || isFpsLimit('60') || isFpsLimit(-1)).toBe(false);
  });
});

describe('display detection', () => {
  it('ignores stalls and uses the saved rate until enough samples arrive', () => {
    const m = new FrameMeter(165);
    expect(m.displayHz).toBe(165);
    m.refresh(0);
    m.refresh(5000); // hidden tab
    for (let i = 1; i < 40; i++) m.refresh(5000 + i * (1000 / 240));
    expect(m.displayHz).toBe(240);
  });
});
