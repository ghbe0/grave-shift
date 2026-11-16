// Frame pacing for high-refresh displays. Browsers call requestAnimationFrame once per display
// refresh (60, 144, 240, 360 Hz...), so "uncapped" means "as fast as the monitor shows frames".
// A cap below the refresh rate drops callbacks so frames land on an even schedule: on a 360 Hz
// display a 144 cap alternates two and three refreshes per frame and averages 144.

/** Frame rate caps the settings can offer; only those below the display's refresh rate are listed. */
export const FPS_CAPS = [30, 60, 75, 90, 100, 120, 144, 165, 180, 200, 240, 280, 300, 360, 480, 500] as const;
export const isFpsLimit = (n: unknown): n is number => n === 0 || (FPS_CAPS as readonly unknown[]).includes(n);

export interface FpsOption { value: number; label: string }

/**
 * Frame rate choices for a display refreshing at `displayHz` (0 while unknown). The first option,
 * 0, draws every refresh, so it always equals the monitor's rate and is the default. Caps at or
 * above the refresh rate would do nothing and are left out, except a saved choice, which is kept
 * (and marked) so moving to a slower monitor never silently changes the setting.
 */
export function frameRateOptions(displayHz: number, saved = 0): FpsOption[] {
  const out: FpsOption[] = [{
    value: 0,
    label: displayHz ? `${displayHz} fps (matches your ${displayHz} Hz display)` : 'Match display (measuring refresh rate...)',
  }];
  for (const cap of FPS_CAPS) {
    if (displayHz ? cap < displayHz : cap <= 360) out.push({ value: cap, label: `${cap} fps` });
  }
  if (saved && !out.some(o => o.value === saved)) out.push({ value: saved, label: `${saved} fps (above this ${displayHz} Hz display)` });
  return out;
}

export class FrameLimiter {
  private next = 0;
  constructor(public limit = 0) {}

  /** Whether to draw on the refresh at `now` (ms). A limit of 0 draws every refresh. */
  shouldRender(now: number): boolean {
    if (!this.limit) return true;
    const interval = 1000 / this.limit;
    // Half a millisecond of slack absorbs callback timing jitter without letting frames bunch up.
    if (now < this.next - 0.5) return false;
    // Advance by whole intervals to keep the average rate exact; resync after a long stall.
    this.next = now - this.next > interval * 4 ? now + interval : this.next + interval;
    return true;
  }
  reset(): void { this.next = 0; }
}

/** Rendered frame rate, frame time and the display refresh rate, over a sliding half second. */
export class FrameMeter {
  private frames: number[] = [];
  private refreshes: number[] = [];
  private lastRefresh = 0;

  /** `seed`: a refresh rate measured earlier (for example last visit), used until a new one is in. */
  constructor(private seed = 0) {}

  /**
   * Call on animation frame callbacks while nothing heavy is drawn (menus). Gaps measured while a
   * 3D frame is rendering show the render time, not the display, so they must not be fed in.
   * Gaps over 100 ms (a hidden tab, a stall) are ignored.
   */
  refresh(now: number): void {
    const gap = now - this.lastRefresh;
    if (this.lastRefresh && gap > 0 && gap < 100) {
      this.refreshes.push(gap);
      if (this.refreshes.length > 240) this.refreshes.shift();
    }
    this.lastRefresh = now;
  }
  /** Call when a frame was actually drawn. */
  rendered(now: number): void {
    this.frames.push(now);
    while (this.frames.length && this.frames[0] < now - 500) this.frames.shift();
  }

  get fps(): number {
    const f = this.frames;
    return f.length < 2 ? 0 : ((f.length - 1) * 1000) / (f[f.length - 1] - f[0]);
  }
  get frameMs(): number { return this.fps ? 1000 / this.fps : 0; }

  /**
   * Display refresh rate estimated from the median gap between animation frames, snapped to
   * common panel rates. 0 until enough samples are in.
   */
  get displayHz(): number {
    if (this.refreshes.length < 30) return this.seed;
    const sorted = [...this.refreshes].sort((a, b) => a - b);
    const hz = 1000 / sorted[sorted.length >> 1];
    const common = [30, 50, 60, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 300, 360, 480, 500];
    const near = common.reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
    return Math.abs(near - hz) / hz < 0.06 ? near : Math.round(hz);
  }
}
