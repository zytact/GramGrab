import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { prepareLocalIpcEndpoint } from './index.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function temporarySocketPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gramgrab-native-host-'));
  temporaryDirectories.push(directory);
  return join(directory, 'gramgrab.sock');
}

describe('native host endpoint ownership', () => {
  it('removes a stale Unix socket file', async () => {
    const path = await temporarySocketPath();
    await writeFile(path, 'stale');

    await prepareLocalIpcEndpoint(path, 'linux');

    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove a live Unix socket', async () => {
    const path = await temporarySocketPath();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });

    await expect(prepareLocalIpcEndpoint(path, 'linux')).rejects.toThrow(
      'Another GramGrab native host already owns'
    );

    expect(server.listening).toBe(true);
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  it('leaves Windows named-pipe arbitration to the operating system', async () => {
    await expect(prepareLocalIpcEndpoint(String.raw`\\.\pipe\gramgrab`, 'win32')).resolves.toBe(
      undefined
    );
  });
});
