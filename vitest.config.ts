import { configDefaults, defineConfig, normalizePath } from 'vite-plus';

const root = normalizePath(__dirname);

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    maxWorkers: 4,
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      '**/__fixtures__/**',
      'apps/cli/bin/**',
      'apps/native-host/manifests/**',
      'install.sh',
      'README.md',
    ].map(pattern => `${root}/${pattern}`),
    setupFiles: ['./apps/extension/src/test/setup.ts'],
    include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
