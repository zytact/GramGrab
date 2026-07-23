import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { Effect, Schema } from 'effect';
import {
  decodeClientMessage,
  decodeJsonFrame,
  encodeJsonFrame,
  PROTOCOL_VERSION,
  Request,
  Status,
} from '@gramgrab/protocol';
import { attachClient, prepareLocalIpcEndpoint } from './index.ts';

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

describe('native host request ownership', () => {
  it('relays protocol-skewed requests for the extension to reject explicitly', async () => {
    const path = await temporarySocketPath();
    const relayed: Uint8Array[] = [];
    const server = createServer(socket => attachClient(socket, payload => relayed.push(payload)));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject);
      client.once('connect', resolve);
    });
    const skewed = {
      version: PROTOCOL_VERSION + 1,
      requestId: crypto.randomUUID(),
      command: { _tag: 'Status' },
    };
    client.write(encodeJsonFrame(skewed));
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(decodeJsonFrame(relayed[0]!)).toEqual(skewed);
    client.end();
    await new Promise<void>(resolve => client.once('close', resolve));
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  it('cancels active requests when their client disconnects', async () => {
    const path = await temporarySocketPath();
    const relayed: Uint8Array[] = [];
    const server = createServer(socket => attachClient(socket, payload => relayed.push(payload)));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    const request = Schema.decodeUnknownSync(Request)({
      version: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      command: Status.make({}),
    });
    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject);
      client.once('connect', resolve);
    });
    client.write(encodeJsonFrame(Schema.encodeSync(Request)(request)));
    await new Promise(resolve => setTimeout(resolve, 10));
    client.end();
    await new Promise<void>(resolve => client.once('close', resolve));

    expect(relayed).toHaveLength(2);
    const cancellation = Effect.runSync(decodeClientMessage(decodeJsonFrame(relayed[1]!)));
    expect(cancellation).toMatchObject({
      _tag: 'CancelRequest',
      requestId: request.requestId,
    });
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });
});
