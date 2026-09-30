// fallow-ignore-file unused-file
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { CHROMIUM_PUBLIC_KEY, chromiumKeyFile } from './release.mjs';

const require = createRequire(import.meta.url);
const Crx = require('crx');

const srcDir = 'extension/chromium';
const output = 'extension/chromium/gramgrab.crx';

if (!existsSync(srcDir)) {
  console.error(`[package-chromium] ${srcDir} not found — run "vp run build:chromium" first`);
  process.exit(1);
}

if (!existsSync(chromiumKeyFile)) {
  console.error(
    `[package-chromium] release key not found at ${chromiumKeyFile}. Set CHROMIUM_CRX_KEY_FILE to the key that matches CHROMIUM_PUBLIC_KEY.`
  );
  process.exit(1);
}

const privateKey = readFileSync(chromiumKeyFile);
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
if (publicKey.toString('base64') !== CHROMIUM_PUBLIC_KEY) {
  console.error(`[package-chromium] ${chromiumKeyFile} does not match CHROMIUM_PUBLIC_KEY`);
  process.exit(1);
}

const crx = new Crx({ rootDirectory: resolve(srcDir), privateKey });

const crxBuffer = await crx.pack();
writeFileSync(output, crxBuffer);
console.log(`[package-chromium] created ${output}`);
