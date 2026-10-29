#!/usr/bin/env node
// A local fixture second account for the Inbox filters and Watch search recipe in
// features/watches.md. Verification profile only.
//
//   watch-filters.mjs seed    add a paused Watch of `creators`, Instagram's other own account, whose
//                             inbox holds one Photo and one Carousel of 2
//   watch-filters.mjs remove  drop the fixture, and nothing else
//
// It is never checked, so it costs no Instagram request. It prints booleans only.
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const [mode] = process.argv.slice(2);
// The fixture carries this Watch ID, so removal never touches a real Watch.
const FIXTURE_ID = 'f0000000-0000-4000-8000-000000000334';

const store = body => `(async () => {
  const store = (await chrome.storage.local.get('watch-store'))['watch-store'];
  const fixture = store?.watches?.find(w => w.id === '${FIXTURE_ID}');
  ${body}
})()`;

const expressions = {
  seed: store(`
  if (fixture) throw new Error('The fixture is already present; remove it first');
  const first = store?.watches?.[0];
  if (!first) throw new Error('An existing verified Watch is required');
  const now = Date.now();
  const takenAt = Math.floor(now / 1000);
  const entry = (ref, ago) => ({
    id: crypto.randomUUID(), checkId: crypto.randomUUID(), discoveredAt: now - ago,
    collect: { at: now - ago }, ref,
  });
  const watch = {
    id: '${FIXTURE_ID}', viewerId: first.viewerId, targetId: '9000000000334',
    username: 'creators', createdAt: now, enabled: false, kinds: ['posts'],
    actions: ['collect'], tracking: {},
    discoveries: [
      entry({ _tag: 'Post', mediaId: '1', shortcode: 'FILTER_FIXTURE_PHOTO', mediaType: 'image', takenAt }, 60_000),
      entry({ _tag: 'Sidecar', mediaId: '2', shortcode: 'FILTER_FIXTURE_CAROUSEL', takenAt,
        children: [{ mediaId: '3', mediaType: 'image' }, { mediaId: '4', mediaType: 'video' }] }, 120_000),
    ],
  };
  await chrome.storage.local.set({ 'watch-store': { ...store, watches: [...store.watches, watch] } });
  return JSON.stringify({ seeded: true });`),
  remove: store(`
  if (!fixture) return JSON.stringify({ removed: false });
  const watches = store.watches.filter(w => w.id !== '${FIXTURE_ID}');
  await chrome.storage.local.set({ 'watch-store': { ...store, watches } });
  return JSON.stringify({ removed: true });`),
};

if (!Object.hasOwn(expressions, mode ?? '')) {
  process.stderr.write('Usage: watch-filters.mjs seed | remove\n');
  process.exit(2);
}

try {
  const { stdout } = await run(
    process.execPath,
    [resolve(here, 'drive.mjs'), 'eval', 'js/background.js', expressions[mode]],
    { env: process.env, timeout: 30_000 }
  );
  process.stdout.write(stdout);
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exit(1);
}
