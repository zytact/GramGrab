// fallow-ignore-file unused-file
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { createManifest, parseBrowserTarget } from './manifest.mjs';

// Target browser is passed via BROWSER env (same as vite.config.ts).
const browser = parseBrowserTarget(process.env.BROWSER ?? 'chromium');
const outDir = `extension/${browser}`;
const manifest = createManifest(browser);

await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

await mkdir(`${outDir}/icons`, { recursive: true });
await copyFile('icons/icon-16.png', `${outDir}/icons/icon-16.png`);
await copyFile('icons/icon-48.png', `${outDir}/icons/icon-48.png`);
await copyFile('icons/icon-96.png', `${outDir}/icons/icon-96.png`);

// License and attribution notices must accompany packaged extension distributions.
await copyFile('LICENSE', `${outDir}/LICENSE`);
await copyFile('THIRD_PARTY_NOTICES', `${outDir}/THIRD_PARTY_NOTICES`);

console.log(`[postbuild] wrote ${outDir}/manifest.json (target: ${browser})`);
