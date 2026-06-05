// fallow-ignore-file unused-file
import { mkdir, writeFile, copyFile } from 'node:fs/promises';

// Target browser is passed via BROWSER env (same as vite.config.ts).
const browser = process.env.BROWSER ?? 'chromium';
const outDir = `extension/${browser}`;

// ---------------------------------------------------------------------------
// Browser-specific manifest generation
// ---------------------------------------------------------------------------

// Fields shared between both targets
const baseManifest = {
  manifest_version: 3,
  name: 'GramGrab',
  version: '1.0.0',
  description:
    'Download Instagram posts, reels, stories, and highlights directly from your browser session.',
  icons: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    96: 'icons/icon-96.png',
  },
  action: {
    default_popup: 'popup.html',
    default_icon: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
    },
    default_title: 'GramGrab',
  },
  permissions: ['downloads', 'storage', 'activeTab', 'tabs', 'scripting'],
  host_permissions: ['https://*.instagram.com/*', 'https://*.fbcdn.net/*'],
};

// Target-specific background section:
// - Chromium MV3 requires service_worker
// - Firefox MV3 uses scripts (does not support service_worker directly)
const background =
  browser === 'chromium'
    ? { service_worker: 'js/background.js', type: 'module' }
    : { scripts: ['js/background.js'], type: 'module' };

const geckoSettings =
  browser === 'firefox'
    ? {
        browser_specific_settings: {
          gecko: { id: 'gramgrab@zytact', strict_min_version: '109.0' },
        },
      }
    : {};

const manifest = { ...baseManifest, background, ...geckoSettings };

await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

await mkdir(`${outDir}/icons`, { recursive: true });
await copyFile('icons/icon-16.png', `${outDir}/icons/icon-16.png`);
await copyFile('icons/icon-48.png', `${outDir}/icons/icon-48.png`);
await copyFile('icons/icon-96.png', `${outDir}/icons/icon-96.png`);

console.log(`[postbuild] wrote ${outDir}/manifest.json (target: ${browser})`);
