// Frame pacing for high-refresh displays. Browsers call requestAnimationFrame once per display
// refresh (60, 144, 240, 360 Hz...), so "uncapped" means "as fast as the monitor shows frames".
// A cap below the refresh rate drops callbacks so frames land on an even schedule: on a 360 Hz
// display a 144 cap alternates two and three refreshes per frame and averages 144.

export const FPS_LIMITS = [0, 30, 60, 120, 144, 165, 240, 360] as const;

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

  /** Call on every animation frame callback (rendered or not). */
  refresh(now: number): void {
    if (this.lastRefresh) {
      this.refreshes.push(now - this.lastRefresh);
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
    if (this.refreshes.length < 30) return 0;
    const sorted = [...this.refreshes].sort((a, b) => a - b);
    const hz = 1000 / sorted[sorted.length >> 1];
    const common = [30, 50, 60, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240, 280, 300, 360, 480, 500];
    const near = common.reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
    return Math.abs(near - hz) / hz < 0.06 ? near : Math.round(hz);
  }
}
