// Streams the procedural material layers into the renderer. Runs in a worker when possible,
// otherwise on the main thread a layer per idle slice.
import type { Sim } from '../core/sim';
import wasmUrl from '../core/sim.wasm?url';
import { MAT_SIZE, type Renderer } from './renderer';

export function streamMaterials(renderer: Renderer, sim: Sim, onLayer: (done: number, total: number) => void = () => {}): Promise<void> {
  const total = sim.materialLayers;
  let done = 0;
  const apply = (layer: number, data: Uint8Array, tile: number) => { renderer.setMaterial(layer, data, tile); onLayer(++done, total); };
  return new Promise(resolve => {
    const fallback = () => {
      let layer = 0;
      const next = () => {
        if (layer >= total) return resolve();
        apply(layer, sim.texgen(layer, MAT_SIZE), sim.materialTile(layer));
        layer++;
        setTimeout(next, 0);
      };
      next();
    };
    try {
      const worker = new Worker(new URL('./texworker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        if (e.data.done) { worker.terminate(); resolve(); return; }
        apply(e.data.layer, new Uint8Array(e.data.data), e.data.tile);
      };
      worker.onerror = () => { worker.terminate(); if (!done) fallback(); else resolve(); };
      worker.postMessage({ url: new URL(wasmUrl, location.href).href, size: MAT_SIZE });
    } catch {
      fallback();
    }
  });
}
