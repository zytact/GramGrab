import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  Accepted,
  decodeClientMessage,
  decodeJsonFrame,
  encodeJsonFrame,
  Event,
  FrameDecoder,
  PROTOCOL_VERSION,
  Request,
  Status,
} from '@gramgrab/protocol';
import { parseCliArguments, request } from './index.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function testEndpoint(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gramgrab-cli-'));
  temporaryDirectories.push(directory);
  return join(directory, 'gramgrab.sock');
}

async function disconnectingServer(endpoint: string, accept: boolean) {
  const server = createServer(socket => {
    const decoder = new FrameDecoder();
    socket.on('data', chunk => {
      if (typeof chunk === 'string') return;
      const frame = decoder.push(chunk)[0];
      if (!frame) return;
      const incoming = Effect.runSync(Schema.decodeUnknown(Request)(decodeJsonFrame(frame)));
      if (accept) {
        socket.write(
          encodeJsonFrame(
            Schema.encodeSync(Event)(
              Event.make({
                version: PROTOCOL_VERSION,
                requestId: incoming.requestId,
                event: Accepted.make({}),
              })
            )
          )
        );
      }
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  return server;
}

describe('CLI capability grammar', () => {
  it('parses inspect and JSON mode', () => {
    const parsed = parseCliArguments(['inspect', 'https://www.instagram.com/p/example/', '--json']);
    expect(parsed.json).toBe(true);
    expect(parsed.command).toMatchObject({
      _tag: 'Inspect',
      sourceUrl: 'https://www.instagram.com/p/example/',
    });
  });

  it.each([
    ['direct', [], 'DirectExport'],
    ['frame', ['--at', '7'], 'FrameExport'],
    ['silent', ['--reencode', 'allow'], 'SilentExport'],
  ])('parses the %s export mode', (mode, options, expectedTag) => {
    const parsed = parseCliArguments([
      'export',
      'https://www.instagram.com/p/example/',
      '--item',
      '2',
      '--mode',
      mode,
      ...options,
    ]);
    expect(parsed.command._tag).toBe('Export');
    if (parsed.command._tag !== 'Export') return;
    expect(parsed.command.operations[0]).toMatchObject({
      itemNumber: 2,
      mode: { _tag: expectedTag },
    });
  });

  it.each([
    [['history', 'list'], 'HistoryList'],
    [['history', 'remove', 'one', 'two'], 'HistoryRemove'],
    [['history', 'clear'], 'HistoryClear'],
    [['history', 'redownload', 'one'], 'HistoryRedownload'],
    [['debug', 'get'], 'DebugGet'],
    [['debug', 'export'], 'DebugExport'],
  ])('parses %s', (arguments_, expectedTag) => {
    expect(parseCliArguments(arguments_).command._tag).toBe(expectedTag);
  });

  it('rejects invalid human item numbers', () => {
    expect(() =>
      parseCliArguments([
        'export',
        'https://www.instagram.com/p/example/',
        '--item',
        '0',
        '--mode',
        'direct',
      ])
    ).toThrow();
  });

  it('requires an explicit silent re-encode policy', () => {
    expect(() =>
      parseCliArguments([
        'export',
        'https://www.instagram.com/p/example/',
        '--item',
        '1',
        '--mode',
        'silent',
      ])
    ).toThrow('Missing --reencode');
  });

  it('parses repeated item operations as a mixed batch', () => {
    const parsed = parseCliArguments([
      'export',
      'https://www.instagram.com/p/example/',
      '--item',
      '1',
      '--mode',
      'direct',
      '--item',
      '3',
      '--mode',
      'frame',
      '--at',
      '8',
    ]);
    expect(parsed.command._tag).toBe('Export');
    if (parsed.command._tag !== 'Export') return;
    expect(parsed.command.operations).toMatchObject([
      { itemNumber: 1, mode: { _tag: 'DirectExport' } },
      { itemNumber: 3, mode: { _tag: 'FrameExport', timestampSeconds: 8 } },
    ]);
  });
});

describe('CLI request lifecycle', () => {
  it.each([false, true])('rejects a clean disconnect after accepted=%s', async accept => {
    const endpoint = await testEndpoint();
    const server = await disconnectingServer(endpoint, accept);

    await expect(
      request(Status.make({}), () => undefined, {
        endpoint,
        acceptanceTimeoutMs: 100,
        terminalTimeoutMs: 100,
      })
    ).rejects.toThrow('IPC disconnected before a terminal response.');

    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });

  it('sends correlated cancellation after an accepted request is aborted', async () => {
    const endpoint = await testEndpoint();
    const messages: unknown[] = [];
    const server = createServer(socket => {
      const decoder = new FrameDecoder();
      socket.on('data', chunk => {
        if (typeof chunk === 'string') return;
        for (const frame of decoder.push(chunk)) {
          const incoming = Effect.runSync(decodeClientMessage(decodeJsonFrame(frame)));
          messages.push(incoming);
          if (!('command' in incoming)) continue;
          socket.write(
            encodeJsonFrame(
              Schema.encodeSync(Event)(
                Event.make({
                  version: PROTOCOL_VERSION,
                  requestId: incoming.requestId,
                  event: Accepted.make({}),
                })
              )
            )
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    const controller = new AbortController();
    const pending = request(
      Status.make({}),
      event => {
        if (event._tag === 'Accepted') controller.abort();
      },
      { endpoint, signal: controller.signal }
    );

    await expect(pending).rejects.toThrow('Request cancelled.');
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      _tag: 'CancelRequest',
      requestId: (messages[0] as { requestId: string }).requestId,
    });
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });
});
