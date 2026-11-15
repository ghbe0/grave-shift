import { defineConfig } from 'vitest/config';

// Relative base so the build works from any GitHub Pages sub-path (user.github.io/<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  // Module workers so the texture worker can import the shared Wasm bindings.
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
});
