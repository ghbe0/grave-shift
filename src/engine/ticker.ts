// Fixed-rate callback that keeps running in hidden tabs. requestAnimationFrame stops when a tab is
// in the background and main-thread timers are throttled to about once a second, which would
// freeze a party whenever its host switched tabs. Timers inside a worker are not throttled that way.
export class Ticker {
  private worker: Worker | null = null;
  private timer = 0;

  constructor(hz: number, private fn: () => void) {
    const src = `setInterval(() => postMessage(0), ${1000 / hz});`;
    try {
      this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      this.worker.onmessage = () => this.fn();
    } catch {
      // Workers can be blocked (e.g. strict CSP); fall back to a plain interval.
      this.timer = window.setInterval(() => this.fn(), 1000 / hz);
    }
  }

  stop(): void {
    this.worker?.terminate();
    clearInterval(this.timer);
  }
}
