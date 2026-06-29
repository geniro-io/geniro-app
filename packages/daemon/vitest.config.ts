import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Resolve the workspace type package to its source so tests run without a
// prior build step (and don't depend on turbo build ordering).
export default defineConfig({
  resolve: {
    alias: {
      '@packages/types': resolve(import.meta.dirname, '../types/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
