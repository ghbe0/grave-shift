// Generates the procedural material layers off the main thread with its own instance of the
// simulation core, and posts each layer back as soon as it is ready.
import { Sim } from '../core/sim';

/** Most visible first, so the level looks finished as early as possible. */
const ORDER = [1, 0, 4, 2, 3, 8, 7, 6, 5, 9];

self.onmessage = async (e: MessageEvent<{ url: string; size: number }>) => {
  const sim = await Sim.load(await fetch(e.data.url));
  for (const layer of ORDER.filter(l => l < sim.materialLayers)) {
    const data = sim.texgen(layer, e.data.size);
    (self as unknown as Worker).postMessage({ layer, tile: sim.materialTile(layer), data }, [data.buffer]);
  }
  (self as unknown as Worker).postMessage({ done: true });
};
