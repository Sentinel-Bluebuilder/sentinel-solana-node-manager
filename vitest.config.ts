import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': '/src/renderer/src' },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
    environmentMatchGlobs: [
      ['tests/renderer/**', 'happy-dom'],
      ['tests/unit/**', 'node'],
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/services/**/*.ts', 'src/shared/**/*.ts'],
    },
  },
});
