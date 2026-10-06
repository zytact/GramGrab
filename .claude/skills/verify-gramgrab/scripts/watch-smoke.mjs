#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { FAILURE_CODES } from '../../../../packages/protocol/src/failures.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const run = promisify(execFile);
const args = process.argv.slice(2);
const doCheck = args.includes('--check');
const evidence = resolve(repo, args.find(arg => !arg.startsWith('--')) ?? '.local/verify-evidence/watch-smoke.json');
if (args.some(arg => arg.startsWith('--') && arg !== '--check') ||
    !evidence.startsWith(resolve(repo, '.local/verify-evidence') + '/')) {
  process.stderr.write('Usage: watch-smoke.mjs [--check] [.local/verify-evidence/run/watch-smoke.json]\n');
  process.exit(2);
}
const results = {};
const codes = new Set();

async function cli(words) {
  let output;
  let exit = 0;
  try {
    output = await run(process.execPath, [resolve(repo, 'artifacts/gramgrab.mjs'), ...words, '--json'],
      { cwd: repo, env: process.env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    exit = typeof error.code === 'number' ? error.code : 1;
    output = error;
  }
  const lines = output.stdout.trim().split('\n').filter(Boolean);
  return { exit, single: lines.length === 1, value: JSON.parse(lines[0]),
    progress: output.stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

async function drive(...words) {
  const output = await run(process.execPath, [resolve(here, 'drive.mjs'), ...words],
    { cwd: repo, env: process.env, timeout: 30_000 });
  return output.stdout.trim();
}

try {
  const health = await cli(['status']);
  results.bridge = health.exit === 0 && health.value.compatible === true;
  let list = await cli(['watch', 'list']);
  const target = list.value.watches.find(watch => watch.username === 'instagram');
  if (doCheck && target) {
    const checked = await cli(['watch', 'check', target.accountId]);
    results.checkTerminal = checked.single && checked.value._tag === 'WatchCheckResult';
    const outcomes = checked.value.outcomes.flatMap(watch => watch.kinds ?? []);
    results.checkProgress = checked.progress.filter(event => event.watchCheck?.outcome).length === outcomes.length;
    const unsuccessful = checked.value.unknownWatches.length > 0 ||
      checked.value.outcomes.some(watch => watch.deferredUntil !== undefined) ||
      outcomes.some(outcome => !['KindBaselineRecorded', 'KindCheckSucceeded'].includes(outcome._tag));
    results.checkExit = checked.exit === (unsuccessful ? 1 : 0);
    for (const outcome of outcomes) if (FAILURE_CODES.includes(outcome.code)) codes.add(outcome.code);
    list = await cli(['watch', 'list']);
  } else if (doCheck) results.checkTerminal = false;
  const needs = await cli(['watch', 'needs']);
  const inbox = await cli(['watch', 'inbox', 'list']);
  results.list = list.exit === 0 && list.single;
  results.needs = needs.exit === 0 && needs.value.items.length === list.value.attentionCount;
  const inboxCount = list.value.watches.reduce((count, watch) => count + watch.inboxCount, 0);
  results.inbox = inbox.exit === 0 && inbox.value.entries.length === inboxCount;
  for (const item of needs.value.items) if (FAILURE_CODES.includes(item.code)) codes.add(item.code);
  const problem = needs.value.items.find(item => item._tag === 'CheckAttention');
  if (problem) {
    const retry = await cli(['watch', 'retry', problem.attentionId]);
    results.checkRecoveryRefused = retry.exit === 1 && retry.value.refused.length === 1;
  }
  for (const action of ['export', 'remove']) {
    const unknown = await cli(['watch', 'inbox', action, 'verification-missing-entry']);
    results[`unknown${action}`] = unknown.exit === 1 && unknown.value.unknownEntryIds.length === 1;
  }
  await drive('open', `chrome-extension://${process.env.GRAMGRAB_EXT_ID}/options.html`);
  await drive('wait', 'options.html', 'WATCHES', '15000');
  results.page = JSON.parse(await drive('eval', 'options.html', `(() => {
    const buttons = [...document.querySelectorAll('.opt-list button')];
    const count = label => Number(buttons.find(button => button.textContent.includes(label))?.querySelector('.opt-count')?.textContent ?? 0);
    return !!document.querySelector('.opt-beta') && count('Needs you') === ${list.value.attentionCount} && count('All inbox') === ${inboxCount};
  })()`));
  await drive('eval', 'options.html', "[...document.querySelectorAll('.opt-list button')].find(button => button.textContent.includes('All inbox'))?.click()");
  results.inboxPage = JSON.parse(await drive('eval', 'options.html', "document.querySelector('h1')?.textContent === 'All inbox'"));
} catch {
  results.completed = false;
}
await mkdir(dirname(evidence), { recursive: true });
const report = { ...results, codes: [...codes] };
await writeFile(evidence, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report) + '\n');
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
