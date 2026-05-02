import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Target browser is passed via the BROWSER env variable.
// Defaults to 'chromium' so plain `vite build` still works during development.
const browser = (process.env.BROWSER ?? 'chromium') as 'chromium' | 'firefox';

export default defineConfig({
  plugins: [react()],
  root: 'templates',
  build: {
    outDir: `../extension/${browser}`,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'templates/popup.html'),
        // background.ts is bundled directly as a JS module entry — no HTML
        // wrapper needed. Both Chromium (service_worker) and Firefox (scripts)
        // reference js/background.js in their respective manifests.
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: 'js/[name].js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: '[ext]/[name].[ext]',
        manualChunks(id) {
          if (id.includes('/src/lib/')) return 'js/bundle';
          return undefined;
        },
      },
      onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        warn(warning);
      },
    },
  },
});
