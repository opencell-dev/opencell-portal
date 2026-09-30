import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Anubis in front of a production build (tests/anubis): slower, needs the
// build and the pinned Anubis release, so it runs on its own
// (`npm run test:anubis`), not with `npm test`.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/anubis/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
