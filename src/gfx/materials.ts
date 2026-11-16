// Streams the procedural material layers into the renderer at a given resolution. Runs in a
// worker when possible, otherwise on the main thread one layer per macrotask. A new stream (for
// example after the texture quality setting changes) cancels the previous one.
import type { Sim } from '../core/sim';
import wasmUrl from '../core/sim.wasm?url';
import type { Renderer } from './renderer';

export interface MaterialStream {
  /** Resolves when every layer is on the GPU, or when the stream is cancelled. */
  done: Promise<void>;
  cancel(): void;
}

export function streamMaterials(renderer: Renderer, sim: Sim, size: number, onLayer: (done: number, total: number) => void = () => {}): MaterialStream {
  const total = sim.materialLayers;
  let finished = 0;
  let cancelled = false;
  let worker: Worker | null = null;
  let resolveDone = () => {};
  const done = new Promise<void>(r => (resolveDone = r));
  const apply = (layer: number, data: Uint8Array, tile: number) => {
    if (cancelled) return;
    renderer.setMaterial(layer, data, tile);
    onLayer(++finished, total);
  };
  const fallback = () => {
    let layer = 0;
    const next = () => {
      if (cancelled || layer >= total) return resolveDone();
      apply(layer, sim.texgen(layer, size), sim.materialTile(layer));
      layer++;
      setTimeout(next, 0);
    };
    next();
  };
  try {
    worker = new Worker(new URL('./texworker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.done) { worker?.terminate(); resolveDone(); return; }
      apply(e.data.layer, new Uint8Array(e.data.data), e.data.tile);
    };
    worker.onerror = () => { worker?.terminate(); if (!finished) fallback(); else resolveDone(); };
    worker.postMessage({ url: new URL(wasmUrl, location.href).href, size });
  } catch {
    fallback();
  }
  return {
    done,
    cancel() {
      cancelled = true;
      worker?.terminate();
      resolveDone();
    },
  };
}
