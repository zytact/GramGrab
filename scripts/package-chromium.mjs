import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Crx = require('crx');

const srcDir = 'extension/chromium';
const keyFile = 'extension/chromium/chromium.pem';
const output = 'extension/chromium/instaext.crx';

if (!existsSync(srcDir)) {
  console.error(`[package-chromium] ${srcDir} not found — run "bun run build:chromium" first`);
  process.exit(1);
}

let privateKey;
if (existsSync(keyFile)) {
  privateKey = readFileSync(keyFile);
  console.log(`[package-chromium] using existing key: ${keyFile}`);
} else {
  const { privateKey: pem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  privateKey = Buffer.from(pem);
  writeFileSync(keyFile, privateKey);
  console.log(`[package-chromium] generated new key: ${keyFile} — keep this safe!`);
}

const crx = new Crx({
  rootDirectory: resolve(srcDir),
  privateKey,
});

const crxBuffer = await crx.pack();
writeFileSync(output, crxBuffer);
console.log(`[package-chromium] created ${output}`);
