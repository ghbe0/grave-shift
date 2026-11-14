import { defineConfig } from 'vitest/config';

// Relative base so the build works from any GitHub Pages sub-path (user.github.io/<repo>/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'] },
});
