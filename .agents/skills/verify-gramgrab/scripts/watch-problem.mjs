#!/usr/bin/env node
// Local fixtures for a Posts check problem on the official `instagram` Watch, for the
// "Check problem" recipe in features/watches.md. Verification profile only.
//
//   watch-problem.mjs hold [MINUTES]      keep all Watch work from starting (default 30)
//   watch-problem.mjs seed CODE [REASON]  record a Posts problem on the `instagram` Watch
//   watch-problem.mjs remove              drop that seeded problem, and nothing else
//   watch-problem.mjs quiet               move the round and early retries 6 hours ahead
//   watch-problem.mjs release             end the hold, so a queued Check now can run
//
// It writes local store state only and never answers for Instagram. It prints
// counts and booleans, never an account, a Watch ID or a username.
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const [mode, first, second] = process.argv.slice(2);
// A seeded problem carries this timestamp, so removal never touches a real one.
const SEEDED_AT = 946684800000;
const HOUR_MS = 60 * 60_000;

const usage = () => {
  process.stderr.write(
    'Usage: watch-problem.mjs hold [MINUTES] | seed CODE [REASON] | remove | quiet | release\n'
  );
  process.exit(2);
};

const literal = value => /^[A-Za-z_-]{1,64}$/.test(value ?? '');
const minutes = Number(first ?? '30');

const scheduler = change => `(async () => {
  const state = (await chrome.storage.local.get('watch-scheduler'))['watch-scheduler'] ?? { version: 1, logins: {} };
  const next = (${change})(state, Date.now());
  await chrome.storage.local.set({ 'watch-scheduler': next });
  return JSON.stringify({ held: (next.startupHoldUntil ?? 0) > Date.now(), logins: Object.keys(next.logins).length });
})()`;

const official = change => `(async () => {
  const store = (await chrome.storage.local.get('watch-store'))['watch-store'];
  const found = (store?.watches ?? []).filter(w => w.username === 'instagram' && w.enabled && w.kinds.includes('posts'));
  if (found.length !== 1) throw new Error('Exactly one enabled instagram Watch with Posts is required');
  let changed = false;
  const watches = store.watches.map(w => {
    if (w !== found[0]) return w;
    const posts = (${change})(w.tracking.posts ?? {});
    changed = posts !== w.tracking.posts;
    return { ...w, tracking: { ...w.tracking, posts } };
  });
  if (changed) await chrome.storage.local.set({ 'watch-store': { ...store, watches } });
  return JSON.stringify({ changed });
})()`;

const expressions = {
  hold: () =>
    Number.isInteger(minutes) && minutes > 0 && minutes <= 120
      ? scheduler(`(state, now) => ({ ...state, startupHoldUntil: now + ${minutes * 60_000} })`)
      : usage(),
  release: () => scheduler(`state => ({ ...state, startupHoldUntil: 0 })`),
  quiet: () =>
    scheduler(`(state, now) => ({ ...state, logins: Object.fromEntries(Object.entries(state.logins).map(([id, login]) => [id, {
      ...login, nextRoundAt: now + ${6 * HOUR_MS}, remaining: [],
      earlyRetries: login.earlyRetries.map(retry => ({ ...retry, at: now + ${6 * HOUR_MS} })),
    }])) })`),
  seed: () =>
    literal(first) && (second === undefined || literal(second))
      ? official(`posts => {
          if (posts.problem && posts.problem.at !== ${SEEDED_AT}) throw new Error('The Watch has a real Posts problem; leave it alone');
          return { ...posts, problem: { code: '${first}', at: ${SEEDED_AT}${second ? `, reason: '${second}'` : ''} } };
        }`)
      : usage(),
  remove: () =>
    official(`posts => {
      if (posts.problem?.at !== ${SEEDED_AT}) return posts;
      const { problem, ...rest } = posts;
      return rest;
    }`),
};

if (!Object.hasOwn(expressions, mode ?? '')) usage();

try {
  const { stdout } = await run(
    process.execPath,
    [resolve(here, 'drive.mjs'), 'eval', 'js/background.js', expressions[mode]()],
    { env: process.env, timeout: 30_000 }
  );
  process.stdout.write(stdout);
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exit(1);
}
