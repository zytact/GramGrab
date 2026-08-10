import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  Accepted,
  decodeClientMessage,
  decodeJsonFrame,
  encodeJsonFrame,
  Event,
  FrameDecoder,
  HumanItemNumber,
  OperationId,
  PROTOCOL_VERSION,
  Progress,
  Request,
  Status,
} from '@gramgrab/protocol';
import { createProgressPrinter, HELP, parseCliArguments, request } from './index.ts';

interface CliProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCliProcess(arguments_: readonly string[]): Promise<CliProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('apps/cli/bin/gramgrab.mjs'), ...arguments_], {
      cwd: process.cwd(),
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      reject(new Error('CLI process did not expose output streams.'));
      return;
    }
    let stdoutText = '';
    let stderrText = '';
    stdout.on('data', chunk => (stdoutText += chunk.toString()));
    stderr.on('data', chunk => (stderrText += chunk.toString()));
    child.once('error', reject);
    child.once('close', code => resolveResult({ code, stdout: stdoutText, stderr: stderrText }));
  });
}

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

  it('resolves a valid bare username to its Stories', () => {
    const parsed = parseCliArguments(['inspect', 'test_user']);
    expect(parsed.command).toMatchObject({
      _tag: 'Inspect',
      sourceUrl: 'https://www.instagram.com/stories/test_user/',
    });
  });

  it.each([
    '@instagram',
    'instagram/user',
    'instagram.com/stories/instagram',
    'not-an-instagram-url',
  ])('rejects invalid source shorthand %s', source => {
    expect(() => parseCliArguments(['inspect', source])).toThrow(
      'expected an Instagram URL or bare username'
    );
  });

  it.each(['https://web.whatsapp.com/status', 'http://web.whatsapp.com/anything/else'])(
    'rejects WhatsApp Status URLs at the CLI boundary: %s',
    source => {
      expect(() => parseCliArguments(['inspect', source])).toThrow(
        'WhatsApp Status downloads are only available in the browser extension.'
      );
    }
  );

  it.each(['https://wa.me/12345', 'https://whatsapp.com/', 'wa.me', 'whatsapp.com'])(
    'keeps WhatsApp marketing links on generic source validation: %s',
    source => {
      expect(() => parseCliArguments(['inspect', source])).toThrow(
        'Invalid SOURCE: expected an Instagram URL or bare username'
      );
    }
  );

  it('reports a missing source when an option occupies its position', () => {
    expect(() => parseCliArguments(['inspect', '--json'])).toThrow('Missing inspect SOURCE.');
  });

  it('parses Instant inspection without a Source', () => {
    expect(parseCliArguments(['instants', 'inspect', '--json'])).toMatchObject({
      json: true,
      command: { _tag: 'InstantsInspect' },
    });
  });

  it('rejects Source arguments for Instant commands', () => {
    expect(() => parseCliArguments(['instants', 'inspect', 'username'])).toThrow(
      'does not accept a Source argument'
    );
    expect(() => parseCliArguments(['instants', 'export', 'username'])).toThrow(
      'does not accept a Source argument'
    );
  });

  it('defaults Instant export to every freshly inspected item', () => {
    expect(parseCliArguments(['instants', 'export'])).toMatchObject({
      command: { _tag: 'InstantsInspect' },
      expandAll: { origin: 'instants', mode: { _tag: 'DirectExport' } },
    });
  });

  it('parses repeated Instant export selections and existing modes', () => {
    const parsed = parseCliArguments([
      'instants',
      'export',
      '--item',
      '1',
      '--mode',
      'direct',
      '--item',
      '2',
      '--mode',
      'silent',
      '--reencode',
      'allow',
    ]);
    expect(parsed.command).toMatchObject({
      _tag: 'InstantsExport',
      operations: [
        { itemNumber: 1, mode: { _tag: 'DirectExport' } },
        { itemNumber: 2, mode: { _tag: 'SilentExport', reencode: 'allow' } },
      ],
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

  it('defers an export without items for fresh all-item expansion', () => {
    const parsed = parseCliArguments(['export', 'https://www.instagram.com/p/example/']);
    expect(parsed.command._tag).toBe('Inspect');
    expect(parsed.expandAll).toMatchObject({
      sourceUrl: 'https://www.instagram.com/p/example/',
      mode: { _tag: 'DirectExport' },
    });
  });

  it('exports Stories from a bare username', () => {
    const parsed = parseCliArguments(['export', 'instagram']);
    expect(parsed.expandAll).toMatchObject({
      sourceUrl: 'https://www.instagram.com/stories/instagram/',
    });
  });

  it('defaults frame export to five seconds', () => {
    const parsed = parseCliArguments([
      'export',
      'https://www.instagram.com/p/example/',
      '--mode',
      'frame',
    ]);
    expect(parsed.expandAll?.mode).toMatchObject({
      _tag: 'FrameExport',
      timestampSeconds: 5,
    });
  });

  it('defaults an item export to direct mode', () => {
    const parsed = parseCliArguments([
      'export',
      'https://www.instagram.com/p/example/',
      '--item',
      '1',
    ]);
    expect(parsed.command).toMatchObject({
      _tag: 'Export',
      operations: [{ itemNumber: 1, mode: { _tag: 'DirectExport' } }],
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

describe('CLI output', () => {
  it('documents help, all-item export, policies, plans, and exit semantics', () => {
    expect(HELP).toContain('gramgrab inspect SOURCE');
    expect(HELP).toContain('gramgrab instants inspect');
    expect(HELP).toContain('A bare username (without\n  @) targets');
    expect(HELP).toContain(
      'WhatsApp Status downloads are only available in the browser extension.'
    );
    expect(HELP).toContain('gramgrab export instagram --item 3 --mode frame --at 5');
    expect(HELP).toContain('defaults to every item found by a fresh inspection');
    expect(HELP).toContain('default when --mode is omitted');
    expect(HELP).toContain('--at defaults to 5 seconds');
    expect(HELP).toContain('forbid');
    expect(HELP).toContain('--plan');
    expect(HELP).toContain('Exit 0');
  });

  it.each([false, true])('rejects invalid source input with exit code 2 (%s JSON)', async json => {
    const result = await runCliProcess([
      'inspect',
      'not-an-instagram-url',
      ...(json ? ['--json'] : []),
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    if (json) {
      expect(JSON.parse(result.stderr)).toEqual({
        type: 'error',
        message: expect.stringContaining('Invalid SOURCE: expected an Instagram URL'),
      });
    } else {
      expect(result.stderr).toContain('Invalid SOURCE: expected an Instagram URL');
    }
  });

  it('rejects WhatsApp Status input with its browser-extension boundary message and exit code 2', async () => {
    const result = await runCliProcess(['inspect', 'https://web.whatsapp.com/status/123']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'WhatsApp Status downloads are only available in the browser extension.\n'
    );
  });

  it('bounds JSON progress while preserving phase transitions and completion', () => {
    const lines: string[] = [];
    const print = createProgressPrinter(true, line => lines.push(line));
    const operationId = Schema.decodeUnknownSync(OperationId)(
      '00000000-0000-4000-8000-000000000001'
    );
    const itemNumber = Schema.decodeUnknownSync(HumanItemNumber)(1);
    for (let index = 0; index <= 2_900; index++)
      print(
        Progress.make({
          operationId,
          itemNumber,
          phase: index < 2_000 ? 'silent-copy' : 'silent-validation',
          progress: index / 2_900,
        })
      );

    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.some(line => line.includes('"phase":"silent-copy"'))).toBe(true);
    expect(lines.some(line => line.includes('"phase":"silent-validation"'))).toBe(true);
    expect(lines.at(-1)).toContain('"progress":1');
  });
});

describe('CLI request lifecycle', () => {
  it('normalizes a missing IPC endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gramgrab-cli-'));
    temporaryDirectories.push(directory);
    const endpoint = join(directory, 'missing.sock');

    await expect(request(Status.make({}), () => undefined, { endpoint })).rejects.toMatchObject({
      code: 'IPC_UNAVAILABLE',
      message: expect.stringContaining('IPC_UNAVAILABLE'),
    });
  });

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
