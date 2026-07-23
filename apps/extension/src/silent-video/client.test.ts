import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { operationIdFrom, requestIdFrom } from '../download/contracts.ts';
import { OperationFailure } from '../errors/contracts.ts';
import { SilentVideoClient } from './client.ts';
import { SilentWorkerError } from './contracts.ts';
import { SilentProcessed } from './contracts.ts';

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly posted: object[] = [];
  terminated = false;
  #messageListeners: ((event: MessageEvent) => void)[] = [];
  #errorListeners: ((event: Event) => void)[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.#messageListeners.push(listener);
    if (type === 'error') this.#errorListeners.push(listener);
  }

  postMessage(message: object): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.#messageListeners) listener(event);
  }
}

describe('SilentVideoClient', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });

  it('rejects requests made after close without posting to the terminated worker', async () => {
    const client = new SilentVideoClient();
    const worker = FakeWorker.instances[0];
    expect(worker).toBeDefined();

    client.close();

    await expect(
      client.inspect(
        operationIdFrom('10000000-0000-4000-8000-000000000001'),
        requestIdFrom('00000000-0000-4000-8000-000000000001'),
        'https://example.com/video.mp4',
        false,
        undefined
      )
    ).rejects.toMatchObject({ code: 'SILENT_WORKER_UNAVAILABLE' });
    expect(worker?.posted).toEqual([]);
    expect(worker?.terminated).toBe(true);
  });

  it('preserves worker error kind and reason for callers', async () => {
    const requestId = requestIdFrom('00000000-0000-4000-8000-000000000002');
    const operationId = operationIdFrom('10000000-0000-4000-8000-000000000002');
    const client = new SilentVideoClient();
    const pending = client.process(operationId, requestId, false, undefined);

    FakeWorker.instances[0]?.emitMessage(
      SilentWorkerError.make({
        operationId,
        requestId,
        failure: OperationFailure.make({
          code: 'SILENT_OUTPUT_NO_VIDEO',
          phase: 'silent-validation',
          scope: 'item',
        }),
      })
    );

    await expect(pending).rejects.toMatchObject({ code: 'SILENT_OUTPUT_NO_VIDEO' });
  });

  it('rejects a valid worker response correlated to the wrong operation ID', async () => {
    const operationId = operationIdFrom('10000000-0000-4000-8000-000000000003');
    const requestId = requestIdFrom('00000000-0000-4000-8000-000000000003');
    const client = new SilentVideoClient();
    const pending = client.process(operationId, requestId, false, undefined);
    FakeWorker.instances[0]?.emitMessage(
      SilentProcessed.make({
        operationId: operationIdFrom('20000000-0000-4000-8000-000000000003'),
        requestId,
        alreadySilent: true,
      })
    );
    await expect(pending).rejects.toMatchObject({ code: 'SILENT_WORKER_PROTOCOL_FAILURE' });
  });
});
