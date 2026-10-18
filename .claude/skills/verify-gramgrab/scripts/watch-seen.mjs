#!/usr/bin/env node
// A local fixture Watch for the "Fetched media is seen" recipe in features/watches.md.
// Verification profile only.
//
//   watch-seen.mjs seed [DAYS]  add a paused Posts and Stories Watch of the `instagram` account,
//                               its baselines DAYS ago (default 7), so recent media is still new
//   watch-seen.mjs read         count the media the fixture records as seen, per kind
//   watch-seen.mjs remove       drop the fixture, and nothing else
//
// It writes local store state only and never answers for Instagram. It prints
// counts and booleans, never an account, a Watch ID or a media ID.
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const [mode, daysArg = '7'] = process.argv.slice(2);
const days = Number(daysArg);
// The fixture carries this Watch ID, so removal never touches a real Watch.
const FIXTURE_ID = 'f0000000-0000-4000-8000-000000000307';

const usage = () => {
  process.stderr.write('Usage: watch-seen.mjs seed [DAYS] | read | remove\n');
  process.exit(2);
};

const store = body => `(async () => {
  const store = (await chrome.storage.local.get('watch-store'))['watch-store'];
  const fixture = store?.watches?.find(w => w.id === '${FIXTURE_ID}');
  ${body}
})()`;

const expressions = {
  seed: () =>
    Number.isInteger(days) && days > 0 && days < 30
      ? store(`
  if (fixture) throw new Error('The fixture is already present; remove it first');
  const found = (store?.watches ?? []).filter(w => w.username === 'instagram');
  if (found.length !== 1) throw new Error('Exactly one instagram Watch is required');
  const now = Date.now();
  const cutoff = { baselineCutoff: Math.floor(now / 1000) - ${days * 86400}, lastSuccessAt: now, lastCheckAt: now };
  const watch = {
    id: '${FIXTURE_ID}', viewerId: found[0].viewerId, targetId: found[0].targetId,
    username: 'instagram', createdAt: now, enabled: false, kinds: ['posts', 'stories'],
    actions: ['collect'], tracking: { posts: cutoff, stories: cutoff }, discoveries: [],
  };
  await chrome.storage.local.set({ 'watch-store': { ...store, watches: [...store.watches, watch] } });
  return JSON.stringify({ seeded: true });`)
      : usage(),
  read: () =>
    store(`
  if (!fixture) return JSON.stringify({ present: false });
  const seen = kind => fixture.tracking[kind]?.seen?.length ?? 0;
  return JSON.stringify({
    present: true, postsSeen: seen('posts'), storiesSeen: seen('stories'),
    discoveries: fixture.discoveries.length,
  });`),
  remove: () =>
    store(`
  if (!fixture) return JSON.stringify({ removed: false });
  const watches = store.watches.filter(w => w.id !== '${FIXTURE_ID}');
  await chrome.storage.local.set({ 'watch-store': { ...store, watches } });
  return JSON.stringify({ removed: true });`),
};

if (!Object.hasOwn(expressions, mode ?? '')) usage();

try {
  const { stdout } = await run(
    process.execPath,
    [resolve(here, 'drive.mjs'), 'eval', 'background.js', expressions[mode]()],
    { env: process.env, timeout: 30_000 }
  );
  process.stdout.write(stdout);
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exit(1);
}
