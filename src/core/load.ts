import { Sim } from './sim';
import wasmUrl from './sim.wasm?url';

/** Fetches and instantiates the simulation core in the browser. */
export async function loadSim(): Promise<Sim> {
  return Sim.load(await fetch(wasmUrl));
}
