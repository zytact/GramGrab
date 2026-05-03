import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const srcDir = 'extension/firefox';

if (!existsSync(srcDir)) {
  console.error(`[package-firefox] ${srcDir} not found — run "bun run build:firefox" first`);
  process.exit(1);
}

const output = 'extension/firefox/instaext.xpi';
execSync(`cd ${srcDir} && zip -r instaext.xpi .`, { stdio: 'inherit' });
console.log(`[package-firefox] created ${output}`);
