import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

let root: string;
let server: Server;
let releaseUrl: string;

async function publish(version: string, { corrupt = false } = {}): Promise<void> {
  const tools = join(root, 'tools');
  await rm(tools, { recursive: true, force: true });
  await mkdir(tools);
  await writeFile(
    join(tools, 'gramgrab.mjs'),
    `#!/usr/bin/env node\nprocess.stdout.write('${version}\\n');\n`
  );
  await writeFile(join(tools, 'gramgrab-native-host.mjs'), '#!/usr/bin/env node\n');
  await chmod(join(tools, 'gramgrab.mjs'), 0o755);
  for (const browser of ['chromium', 'firefox'])
    await copyFile(
      resolve(`apps/native-host/manifests/${browser}.json`),
      join(tools, `${browser}.json`)
    );
  const release = join(root, 'release');
  await mkdir(release, { recursive: true });
  await run('tar', ['-czf', join(release, 'gramgrab-tools.tar.gz'), '-C', tools, '.']);
  const tarball = await readFile(join(release, 'gramgrab-tools.tar.gz'));
  const hash = createHash('sha256')
    .update(corrupt ? 'tampered' : tarball)
    .digest('hex');
  await writeFile(join(release, 'SHA256SUMS'), `${hash}  gramgrab-tools.tar.gz\n`);
}

function run(
  command: string,
  arguments_: string[]
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, {
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        GRAMGRAB_RELEASE_URL: releaseUrl,
      },
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, output }));
  });
}

const install = () => run('sh', [resolve('install.sh')]);
const dataDir = () => join(root, 'home/.local/share/gramgrab');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gramgrab-install-'));
  server = createServer(async (request, response) => {
    try {
      response.end(await readFile(join(root, 'release', request.url ?? '')));
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no port.');
  releaseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('install.sh', () => {
  it('links the CLI and points the native host manifests through the current version', async () => {
    await publish('1.2.3');

    expect((await install()).code).toBe(0);

    expect(await realpath(join(root, 'home/.local/bin/gramgrab'))).toBe(
      await realpath(join(dataDir(), 'versions/1.2.3/gramgrab.mjs'))
    );
    for (const browser of ['chromium', 'firefox']) {
      const manifest = JSON.parse(await readFile(join(dataDir(), `${browser}.json`), 'utf8')) as {
        path: string;
      };
      expect(manifest.path).toBe(join(dataDir(), 'current/gramgrab-native-host.mjs'));
    }
  });

  it('switches to the new version and keeps only the one it replaced', async () => {
    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      await publish(version);
      expect((await install()).code).toBe(0);
    }

    expect((await readdir(join(dataDir(), 'versions'))).sort()).toEqual(['1.1.0', '1.2.0']);
    expect((await run(join(root, 'home/.local/bin/gramgrab'), [])).output).toBe('1.2.0\n');
  });

  it('refuses a tarball that does not match the release checksum', async () => {
    await publish('1.0.0');
    await install();
    await publish('1.1.0', { corrupt: true });

    const result = await install();

    expect(result.code).toBe(1);
    expect(result.output).toContain('does not match the release checksum');
    expect(await realpath(join(dataDir(), 'current'))).toBe(
      await realpath(join(dataDir(), 'versions/1.0.0'))
    );
  });
});
