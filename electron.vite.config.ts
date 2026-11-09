import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * externalizeDepsPlugin only externalizes top-level package.json deps. We
 * also need to keep transitive native/optional deps (bufferutil, ws,
 * utf-8-validate, better-sqlite3, etc.) out of the main-process bundle so
 * Electron can resolve them from node_modules at runtime. Listing them as
 * external below is the standard electron-vite idiom.
 */
const EXTERNALS_MAIN = [
  'electron',
  'dockerode',
  'ssh2',
  'better-sqlite3',
  'winston',
  'qrcode',
  'adm-zip',
  '@solana/web3.js',
  '@solana/spl-token',
  '@scure/bip39',
  'ws',
  'bufferutil',
  'utf-8-validate',
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: EXTERNALS_MAIN,
        output: {
          // Emit CommonJS so Electron loads the main process out of asar
          // reliably on all platforms (ESM from asar is still flaky).
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
