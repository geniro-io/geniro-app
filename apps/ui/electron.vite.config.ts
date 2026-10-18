import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [tailwindcss(), react()],
    server: {
      // In DEVELOPMENT the LAN gateway has no `out/renderer` to serve from,
      // so it proxies the page to this dev server — and vite runs a host
      // allowlist of its own, which refused the `.local` name the gateway
      // advertises as its PRIMARY link. Measured by opening that link from a
      // second client: vite's own "Blocked request… add to server.allowedHosts"
      // page, never geniro's guard, and only under `pnpm dev`; a packaged
      // build serves the bundle off disk with no vite in the path.
      //
      // A suffix entry rather than this machine's hostname, which is not
      // knowable at config time and changes with the network. It widens
      // nothing that matters: the gateway's own Host guard still runs first
      // and still refuses everything that is not loopback, a private
      // address or a `.local` name, and the dev server is only ever reached
      // THROUGH it.
      allowedHosts: ['.local'],
    },
    build: {
      // electron-vite leaves the renderer unminified by default, so the
      // packaged app shipped a 4.8 MB startup chunk (and ~10 MB of renderer
      // JS in all) for the window to parse on every launch. Whitespace and
      // syntax only: identifiers keep their names, so a renderer stack trace
      // in the debug log still reads.
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    esbuild: { minifyIdentifiers: false },
  },
});
