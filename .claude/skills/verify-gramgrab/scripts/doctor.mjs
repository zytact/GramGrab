#!/usr/bin/env node
// Read-only health check for the session launch.sh started. Answers "is this
// instance worth driving?" and exits non-zero when it is not.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const sessionFile = resolve(repo, '.local/verify/session.env');
const drive = resolve(here, 'drive.mjs');

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}\n`);
};

let session;
try {
  session = Object.fromEntries(
    readFileSync(sessionFile, 'utf8')
      .split('\n')
      .filter(line => line.startsWith('export '))
      .map(line => line.slice(7).split(/=(.*)/s).slice(0, 2))
  );
  record('session file', true, sessionFile);
} catch {
  record('session file', false, `missing ${sessionFile}; run scripts/launch.sh`);
  process.exit(1);
}

const env = { ...process.env, ...session };

try {
  process.kill(Number(session.GRAMGRAB_VERIFY_PID), 0);
  record('browser process', true, `pid ${session.GRAMGRAB_VERIFY_PID}`);
} catch {
  record('browser process', false, `pid ${session.GRAMGRAB_VERIFY_PID} is gone`);
}

try {
  const version = await fetch(`http://127.0.0.1:${session.GRAMGRAB_CDP_PORT}/json/version`).then(
    response => response.json()
  );
  record('cdp endpoint', true, version.Browser ?? version.product);
} catch (error) {
  record('cdp endpoint', false, error.message);
}

// Ask the browser itself which extensions it loaded, rather than trusting the
// command line we passed it.
try {
  execFileSync('node', [drive, 'open', 'chrome://extensions'], { env, stdio: 'ignore' });
  const raw = execFileSync(
    'node',
    [
      drive,
      'eval',
      'chrome://extensions',
      'new Promise(r=>chrome.developerPrivate.getExtensionsInfo(i=>r(JSON.stringify(i.map(e=>({id:e.id,name:e.name,state:e.state,version:e.version}))))))',
    ],
    { env, encoding: 'utf8' }
  );
  const found = JSON.parse(raw).find(item => item.id === session.GRAMGRAB_EXT_ID);
  const expected = (
    await import(resolve(repo, 'apps/extension/scripts/manifest.mjs'))
  ).createManifest('chromium').version;
  if (!found) record('extension loaded', false, `no extension with id ${session.GRAMGRAB_EXT_ID}`);
  else if (found.state !== 'ENABLED') record('extension loaded', false, `state ${found.state}`);
  else if (found.version !== expected)
    record('extension build', false, `running ${found.version}, source says ${expected}`);
  else record('extension loaded', true, `${found.name} ${found.version}`);
} catch (error) {
  record('extension loaded', false, String(error.message).split('\n')[0]);
}

try {
  const mode = statSync(session.GRAMGRAB_IPC_PATH).mode & 0o777;
  record(
    'native host socket',
    mode === 0o600,
    `${session.GRAMGRAB_IPC_PATH} mode ${mode.toString(8)}`
  );
} catch {
  record('native host socket', false, `no socket at ${session.GRAMGRAB_IPC_PATH}`);
}

try {
  const output = execFileSync('node', [resolve(repo, 'apps/cli/bin/gramgrab.mjs'), 'status'], {
    env,
    encoding: 'utf8',
  });
  const status = JSON.parse(output);
  record(
    'cli round trip',
    status.compatible === true,
    `extension ${status.extensionVersion}, protocol ${status.protocolVersion}`
  );
} catch (error) {
  record('cli round trip', false, String(error.message).split('\n')[0]);
}

process.exit(checks.every(check => check.ok) ? 0 : 1);
