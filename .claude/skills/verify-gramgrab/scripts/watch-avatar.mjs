#!/usr/bin/env node
// A local fixture Avatar entry for the Inbox preview recipe in features/watches.md.
// Verification profile only.
//
//   watch-avatar.mjs seed    add a paused Avatar Watch of the `instagram` account whose inbox holds
//                            one Avatar change recorded as the picture the real Watch last saw
//   watch-avatar.mjs remove  drop the fixture, and nothing else
//
// The recorded picture is the current one, so exporting it passes the identity check. It writes
// local store state only and prints booleans, never an account, a Watch ID or a picture ID.
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const [mode] = process.argv.slice(2);
// The fixture carries this Watch ID, so removal never touches a real Watch.
const FIXTURE_ID = 'f0000000-0000-4000-8000-000000000330';

const store = body => `(async () => {
  const store = (await chrome.storage.local.get('watch-store'))['watch-store'];
  const fixture = store?.watches?.find(w => w.id === '${FIXTURE_ID}');
  ${body}
})()`;

const expressions = {
  seed: store(`
  if (fixture) throw new Error('The fixture is already present; remove it first');
  const found = (store?.watches ?? []).filter(w => w.username === 'instagram');
  const pictureId = found[0]?.tracking?.avatar?.pictureId;
  if (found.length !== 1 || !pictureId)
    throw new Error('Exactly one instagram Watch with a checked Avatar is required');
  const now = Date.now();
  const watch = {
    id: '${FIXTURE_ID}', viewerId: found[0].viewerId, targetId: found[0].targetId,
    username: 'instagram', createdAt: now, enabled: false, kinds: ['avatar'],
    actions: ['collect'], tracking: { avatar: { pictureId, lastCheckAt: now, lastSuccessAt: now } },
    discoveries: [{
      id: crypto.randomUUID(), checkId: crypto.randomUUID(), discoveredAt: now,
      collect: { at: now }, ref: { _tag: 'Avatar', pictureId },
    }],
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
  process.stderr.write('Usage: watch-avatar.mjs seed | remove\n');
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
