// Builds the Rust simulation core to WebAssembly and copies it where Vite can import it.
// No wasm-bindgen: the crate exposes a plain C ABI, so the cargo output is used as-is.
import { execSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';

execSync('cargo build -p gs-sim --release --target wasm32-unknown-unknown', { stdio: 'inherit' });
const out = 'src/core/sim.wasm';
copyFileSync('target/wasm32-unknown-unknown/release/gs_sim.wasm', out);
console.log(`${out}: ${(statSync(out).size / 1024).toFixed(0)} KiB`);
