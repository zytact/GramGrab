import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  operationIdFrom,
  requestIdFrom,
  type OperationId,
  type RequestId,
} from '../download/contracts.ts';
import { OperationFailure } from '../errors/contracts.ts';
import type { AttemptOperation } from '../download/attempt.ts';
import { runSilentVideoBatch } from './batch.ts';
import {
  SilentInspected,
  SilentPreflight,
  SilentProcessed,
  SilentReleased,
  SilentWorkerError,
} from './contracts.ts';

import { createMemoryDirectory, workerAdapter } from '../test/silent-browser.ts';

type DownloadListener = (delta: { id: number; state?: { current?: string } }) => void;

const NativeURL = globalThis.URL;

function operation(index: number): AttemptOperation {
  return {
    operationId: operationIdFrom(`10000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    requestId: requestIdFrom(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    itemIndex: index,
    displayIndex: index,
    url: `https://example.com/${index}.mp4`,
    filename: `${index}.mp4`,
    originalUrl: `https://example.com/${index}.mp4`,
    originalFilename: `${index}.mp4`,
    mediaType: 'video',
    mode: 'silent',
  };
}

function inspected(operationId: OperationId, requestId: RequestId) {
  return SilentInspected.make({
    preflight: SilentPreflight.make({
      requestId,
      operationId,
      audioTrackCount: 1,
      videoCodec: 'avc',
      durationSeconds: 1,
      width: 16,
      height: 16,
      copyCompatible: true,
    }),
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe('silent video batch', () => {
  let directory: ReturnType<typeof createMemoryDirectory>;
  let downloadListeners: ((delta: { id: number; state?: { current?: string } }) => void)[];
  let nextDownloadId: number;

  beforeEach(() => {
    directory = createMemoryDirectory();
    downloadListeners = [];
    nextDownloadId = 1;
    workerAdapter.instance = undefined;
    vi.stubGlobal('Worker', workerAdapter.Worker);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: () => Promise.resolve(directory) },
    });
    vi.stubGlobal('browser', {
      runtime: {
        getURL: (path: string) => path,
        sendMessage: () => Promise.resolve({}),
        onMessage: { addListener: () => {} },
      },
      downloads: {
        download: () => Promise.resolve(nextDownloadId++),
        search: () => Promise.resolve([]),
        onChanged: {
          addListener: (listener: (delta: { id: number }) => void) => {
            downloadListeners.push(listener);
          },
          removeListener: (listener: (delta: { id: number }) => void) => {
            downloadListeners = downloadListeners.filter(candidate => candidate !== listener);
          },
        },
      },
    });
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        static override createObjectURL(file: File): string {
          return `blob:${file.name}`;
        }

        static override revokeObjectURL(): void {}
      }
    );
  });

  it('keeps the worker alive until the batch and every owned download are complete', async () => {
    const operations = [operation(1), operation(2)];
    const firstHistory = deferred<unknown>();
    const historyStarted = deferred<void>();
    let historyCalls = 0;
    globalThis.browser = {
      runtime: {
        getURL: (path: string) => path,
        sendMessage: () => {
          historyCalls++;
          historyStarted.resolve();
          return historyCalls === 1 ? firstHistory.promise : Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
      },
      downloads: {
        download: () => Promise.resolve(nextDownloadId++),
        search: () => Promise.resolve([]),
        onChanged: {
          addListener: (listener: DownloadListener) => downloadListeners.push(listener),
          removeListener: (listener: DownloadListener) => {
            downloadListeners = downloadListeners.filter(candidate => candidate !== listener);
          },
        },
      },
    };

    let processCount = 0;
    const batch = runSilentVideoBatch(
      operations,
      candidates =>
        Promise.resolve(new Set(candidates.map(candidate => candidate.operation.operationId))),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      new Set()
    );
    const worker = workerAdapter.instance;
    expect(worker).toBeDefined();
    if (!worker) throw new Error('Expected the batch worker to be created.');
    worker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect' && request.operationId)
        worker.respond(inspected(request.operationId, request.requestId));
      if (request._tag === 'process') {
        processCount++;
        directory.files.set(`${request.requestId}.mp4`, ['silent video']);
        worker.respond(
          SilentProcessed.make({
            operationId: request.operationId,
            requestId: request.requestId,
            alreadySilent: false,
            opfsName: `${request.requestId}.mp4`,
          })
        );
      }
      if (request._tag === 'release')
        worker.respond(
          SilentReleased.make({ operationId: request.operationId, requestId: request.requestId })
        );
    };

    await historyStarted.promise;
    expect(historyCalls).toBe(1);
    for (const listener of downloadListeners) listener({ id: 1, state: { current: 'complete' } });
    await drainMicrotasks();
    expect(worker.terminated).toBe(false);

    firstHistory.resolve({});
    await drainMicrotasks();
    expect(processCount).toBe(2);
    const results = await batch;
    expect(results.outcomes.map(result => result.status)).toEqual(['started', 'started']);
    expect(worker.terminated).toBe(false);

    for (const listener of downloadListeners) listener({ id: 2, state: { current: 'complete' } });
    await drainMicrotasks();
    expect(worker.terminated).toBe(true);
  });

  it('processes an inspected video while the next input is still downloading', async () => {
    const operations = [operation(11), operation(12), operation(13)];
    const secondInspection = deferred<void>();
    const batch = runSilentVideoBatch(
      operations,
      () => Promise.resolve(new Set<string>()),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      new Set()
    );
    const worker = workerAdapter.instance;
    if (!worker) throw new Error('Expected the batch worker to be created.');
    worker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect') {
        if (request.operationId === operations[1]?.operationId) {
          void secondInspection.promise.then(() => {
            if (request.operationId && request.requestId)
              worker.respond(inspected(request.operationId, request.requestId));
          });
          return;
        }
        worker.respond(inspected(request.operationId, request.requestId));
      }
      if (request._tag === 'process') {
        directory.files.set(`${request.requestId}.mp4`, ['silent video']);
        worker.respond(
          SilentProcessed.make({
            operationId: request.operationId,
            requestId: request.requestId,
            alreadySilent: false,
            opfsName: `${request.requestId}.mp4`,
          })
        );
      }
    };

    await drainMicrotasks();
    expect(
      worker.requests.some(
        request => request._tag === 'process' && request.operationId === operations[0]?.operationId
      )
    ).toBe(true);
    expect(
      worker.requests.some(
        request => request._tag === 'inspect' && request.operationId === operations[1]?.operationId
      )
    ).toBe(true);

    secondInspection.resolve();
    const results = await batch;
    expect(results.outcomes.map(result => result.status)).toEqual([
      'started',
      'started',
      'started',
    ]);
  });

  it('stops inspecting inputs once the processing buffer is full', async () => {
    const operations = [15, 16, 17, 18, 19].map(operation);
    void runSilentVideoBatch(
      operations,
      () => Promise.resolve(new Set<string>()),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      new Set()
    );
    const worker = workerAdapter.instance;
    if (!worker) throw new Error('Expected the batch worker to be created.');
    worker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      // Processing never answers, so every inspected input keeps holding its slot.
      if (request._tag === 'inspect')
        worker.respond(inspected(request.operationId, request.requestId));
    };

    await drainMicrotasks();
    expect(worker.requests.filter(request => request._tag === 'inspect')).toHaveLength(3);
  });

  it('downloads an already-silent video from its cached input instead of the network', async () => {
    const target = operation(14);
    directory.files.set(`${target.operationId}.source`, ['already silent']);
    const downloaded: string[] = [];
    globalThis.browser = {
      runtime: {
        getURL: (path: string) => path,
        sendMessage: () => Promise.resolve({}),
        onMessage: { addListener: () => {} },
      },
      downloads: {
        download: ({ url }: { url: string }) => {
          downloaded.push(url);
          return Promise.resolve(nextDownloadId++);
        },
        search: () => Promise.resolve([]),
        onChanged: {
          addListener: (listener: DownloadListener) => downloadListeners.push(listener),
          removeListener: (listener: DownloadListener) => {
            downloadListeners = downloadListeners.filter(candidate => candidate !== listener);
          },
        },
      },
    };

    const batch = runSilentVideoBatch(
      [target],
      () => Promise.resolve(new Set<string>()),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      new Set()
    );
    const worker = workerAdapter.instance;
    if (!worker) throw new Error('Expected the batch worker to be created.');
    worker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect')
        worker.respond(inspected(request.operationId, request.requestId));
      if (request._tag === 'process')
        worker.respond(
          SilentProcessed.make({
            operationId: request.operationId,
            requestId: request.requestId,
            alreadySilent: true,
          })
        );
      if (request._tag === 'release')
        worker.respond(
          SilentReleased.make({ operationId: request.operationId, requestId: request.requestId })
        );
    };

    await expect(batch).resolves.toMatchObject({ outcomes: [{ status: 'started' }] });
    expect(downloaded).toEqual([`blob:${target.operationId}.source`]);
  });

  it('asks before re-encoding a rotated video that is already silent', async () => {
    const target = { ...operation(15), rotation: 90 as const };
    const approveReencode = vi.fn(() => Promise.resolve(new Set<string>()));
    const batch = runSilentVideoBatch(
      [target],
      approveReencode,
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      new Set()
    );
    const worker = workerAdapter.instance;
    if (!worker) throw new Error('Expected the batch worker to be created.');
    worker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect')
        worker.respond(
          SilentInspected.make({
            preflight: SilentPreflight.make({
              requestId: request.requestId,
              operationId: request.operationId,
              audioTrackCount: 0,
              videoCodec: 'hevc',
              durationSeconds: 1,
              width: 16,
              height: 16,
              copyCompatible: false,
            }),
          })
        );
      if (request._tag === 'release')
        worker.respond(
          SilentReleased.make({ operationId: request.operationId, requestId: request.requestId })
        );
    };

    await expect(batch).resolves.toMatchObject({ outcomes: [{ status: 'skipped' }] });
    expect(approveReencode).toHaveBeenCalledOnce();
  });

  it('preserves a worker failure kind and reason in the batch result', async () => {
    const operationToFail = operation(3);
    const batch = runSilentVideoBatch(
      [operationToFail],
      candidates =>
        Promise.resolve(new Set(candidates.map(candidate => candidate.operation.operationId))),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      new Set()
    );
    const worker = workerAdapter.instance;
    if (!worker) throw new Error('Expected the batch worker to be created.');
    worker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect' && request.operationId)
        worker.respond(inspected(request.operationId, request.requestId));
      if (request._tag === 'process')
        worker.respond(
          SilentWorkerError.make({
            operationId: request.operationId,
            requestId: request.requestId,
            failure: OperationFailure.make({
              code: 'SILENT_STORAGE_CAPACITY_EXCEEDED',
              phase: 'silent-storage',
              scope: 'item',
            }),
          })
        );
    };

    await expect(batch).resolves.toMatchObject({
      outcomes: [
        {
          requestId: operationToFail.requestId,
          status: 'failed',
          failure: { code: 'SILENT_STORAGE_CAPACITY_EXCEEDED' },
        },
      ],
    });
  });

  it('reuses cached input for an approved re-encode with stable operation and fresh request IDs', async () => {
    const first = operation(4);
    const approved = new Set<string>();
    const firstBatch = runSilentVideoBatch(
      [first],
      candidates =>
        Promise.resolve(new Set(candidates.map(candidate => candidate.operation.operationId))),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      approved
    );
    const firstWorker = workerAdapter.instance;
    if (!firstWorker) throw new Error('Expected the first worker to be created.');
    firstWorker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect')
        firstWorker.respond(inspected(request.operationId, request.requestId));
      if (request._tag === 'process')
        firstWorker.respond(
          SilentWorkerError.make({
            operationId: request.operationId,
            requestId: request.requestId,
            failure: OperationFailure.make({
              code: 'SILENT_COPY_FAILED',
              phase: 'silent-copy',
              scope: 'item',
            }),
          })
        );
    };
    await expect(firstBatch).resolves.toMatchObject({
      outcomes: [{ status: 'failed', failure: { code: 'SILENT_COPY_FAILED' } }],
    });

    approved.add(first.operationId);
    const second = { ...first, requestId: requestIdFrom('00000000-0000-4000-8000-000000000104') };
    const secondBatch = runSilentVideoBatch(
      [second],
      candidates =>
        Promise.resolve(new Set(candidates.map(candidate => candidate.operation.operationId))),
      () => {},
      'https://www.instagram.com/p/example/',
      () => {},
      approved
    );
    const secondWorker = workerAdapter.instance;
    if (!secondWorker) throw new Error('Expected the second worker to be created.');
    secondWorker.onRequest = request => {
      if (!request.requestId || !request.operationId) return;
      if (request._tag === 'inspect')
        secondWorker.respond(inspected(request.operationId, request.requestId));
      if (request._tag === 'process')
        secondWorker.respond(
          SilentProcessed.make({
            operationId: request.operationId,
            requestId: request.requestId,
            alreadySilent: true,
          })
        );
      if (request._tag === 'release')
        secondWorker.respond(
          SilentReleased.make({
            operationId: request.operationId,
            requestId: request.requestId,
          })
        );
    };
    await expect(secondBatch).resolves.toMatchObject({ outcomes: [{ status: 'started' }] });
    expect(second.operationId).toBe(first.operationId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(secondWorker.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _tag: 'inspect', useCachedInput: true }),
        expect.objectContaining({ _tag: 'process', transcode: true }),
      ])
    );
  });
});
