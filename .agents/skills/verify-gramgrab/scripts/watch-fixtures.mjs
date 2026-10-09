#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const [mode, countArg = '12'] = process.argv.slice(2);
const count = Number(countArg);
// Fixture target IDs share this prefix so removal never depends on worker memory.
const PREFIX = '9000000000000';

if (!['seed', 'remove'].includes(mode) || !Number.isInteger(count) || count < 1 || count > 50) {
  process.stderr.write('Usage: watch-fixtures.mjs seed [COUNT] | remove\n');
  process.exit(2);
}

const seed = `(async () => {
  const store = (await chrome.storage.local.get('watch-store'))['watch-store'];
  const first = store?.watches?.[0];
  if (!first) throw new Error('An existing verified Watch is required');
  if (store.watches.some(w => w.targetId.startsWith('${PREFIX}'))) throw new Error('Fixtures already present; remove them first');
  const now = Date.now();
  const watches = Array.from({ length: ${count} }, (_, i) => ({
    id: crypto.randomUUID(), viewerId: first.viewerId, targetId: '${PREFIX}' + String(i).padStart(2, '0'),
    username: 'instagram', createdAt: now, enabled: false,
    kinds: ['posts', 'stories', 'instants', 'avatar'], actions: ['collect'], tracking: {},
    discoveries: Array.from({ length: 40 }, () => ({
      id: crypto.randomUUID(), checkId: crypto.randomUUID(), discoveredAt: now, collect: { at: now },
      ref: { _tag: 'Post', mediaId: '1', shortcode: 'LAYOUT_FIXTURE', mediaType: 'image', takenAt: Math.floor(now / 1000) },
    })),
  }));
  await chrome.storage.local.set({ 'watch-store': { ...store, watches: [...store.watches, ...watches] } });
  return 'Seeded ${count} paused fixture Watches';
})()`;

const remove = `(async () => {
  const store = (await chrome.storage.local.get('watch-store'))['watch-store'];
  const watches = store.watches.filter(w => !w.targetId.startsWith('${PREFIX}'));
  await chrome.storage.local.set({ 'watch-store': { ...store, watches } });
  return 'Removed ' + (store.watches.length - watches.length) + ' fixture Watches';
})()`;

try {
  const { stdout } = await run(
    process.execPath,
    [resolve(here, 'drive.mjs'), 'eval', 'background.js', mode === 'seed' ? seed : remove],
    { env: process.env, timeout: 30_000 }
  );
  process.stdout.write(stdout);
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exit(1);
}
