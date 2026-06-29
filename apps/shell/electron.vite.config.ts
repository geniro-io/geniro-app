import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Bundle the tiny shared types/consts package into main+preload (so neither
// process has to `require` a workspace package at runtime); keep native and
// heavy deps (better-sqlite3, @napi-rs/keyring, electron-updater) external.
const typesAlias = {
  '@packages/types': resolve(__dirname, '../../packages/types/src/index.ts'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@packages/types'] })],
    resolve: { alias: typesAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@packages/types'] })],
    resolve: { alias: typesAlias },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: typesAlias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
