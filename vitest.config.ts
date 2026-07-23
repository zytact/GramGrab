import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./apps/extension/src/test/setup.ts'],
    include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
