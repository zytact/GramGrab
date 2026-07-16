import type { OperationId, RequestId } from '../download/contracts.ts';
import { OperationFailure } from '../errors/contracts.ts';
import {
  decodeSilentWorkerResponse,
  InspectSilentVideo,
  ProcessSilentVideo,
  ReleaseSilentVideo,
  type SilentPreflight,
  type SilentWorkerResponse,
} from './contracts.ts';

type Pending = {
  operationId: OperationId;
  resolve: (response: SilentWorkerResponse) => void;
  reject: (error: unknown) => void;
  onProgress?: (phase: string, progress: number) => void;
};

export class SilentVideoClient {
  readonly #worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  readonly #pending = new Map<string, Pending>();
  #closed = false;

  constructor() {
    this.#worker.addEventListener('message', event => void this.#receive(event.data));
    this.#worker.addEventListener('error', () => {
      this.#closed = true;
      this.#failAll(workerFailure('SILENT_WORKER_UNAVAILABLE'));
    });
  }

  async inspect(
    operationId: OperationId,
    requestId: RequestId,
    url: string,
    useCachedInput: boolean,
    onProgress: Pending['onProgress']
  ): Promise<SilentPreflight> {
    const response = await this.#request(
      operationId,
      requestId,
      InspectSilentVideo.make({ operationId, requestId, url, useCachedInput }),
      onProgress
    );
    if (response._tag !== 'inspected')
      throw response._tag === 'SilentWorkerError'
        ? response.failure
        : workerFailure('SILENT_WORKER_PROTOCOL_FAILURE');
    return response.preflight;
  }

  async process(
    operationId: OperationId,
    requestId: RequestId,
    transcode: boolean,
    onProgress: Pending['onProgress']
  ) {
    const response = await this.#request(
      operationId,
      requestId,
      ProcessSilentVideo.make({ operationId, requestId, transcode }),
      onProgress
    );
    if (response._tag !== 'processed')
      throw response._tag === 'SilentWorkerError'
        ? response.failure
        : workerFailure('SILENT_WORKER_PROTOCOL_FAILURE');
    return response;
  }

  release(operationId: OperationId, requestId: RequestId): Promise<unknown> {
    return this.#request(
      operationId,
      requestId,
      ReleaseSilentVideo.make({ operationId, requestId })
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    this.#failAll(workerFailure('SILENT_WORKER_UNAVAILABLE'));
  }

  #request(
    operationId: OperationId,
    requestId: RequestId,
    message: object,
    onProgress?: Pending['onProgress']
  ): Promise<SilentWorkerResponse> {
    if (this.#closed) return Promise.reject(workerFailure('SILENT_WORKER_UNAVAILABLE'));
    if (this.#pending.has(requestId))
      return Promise.reject(workerFailure('SILENT_WORKER_PROTOCOL_FAILURE'));
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, {
        operationId,
        resolve,
        reject,
        ...(onProgress ? { onProgress } : {}),
      });
      this.#worker.postMessage(message);
    });
  }

  async #receive(value: unknown): Promise<void> {
    let response: SilentWorkerResponse;
    try {
      response = await decodeSilentWorkerResponse(value);
    } catch {
      this.#failAll(workerFailure('SILENT_WORKER_PROTOCOL_FAILURE'));
      return;
    }
    const requestId =
      response._tag === 'inspected' ? response.preflight.requestId : response.requestId;
    const pending = this.#pending.get(requestId);
    if (!pending) {
      this.#failAll(workerFailure('SILENT_WORKER_PROTOCOL_FAILURE'));
      return;
    }
    const operationId =
      response._tag === 'inspected' ? response.preflight.operationId : response.operationId;
    if (operationId !== pending.operationId) {
      this.#failAll(workerFailure('SILENT_WORKER_PROTOCOL_FAILURE'));
      return;
    }
    if (response._tag === 'progress') {
      pending.onProgress?.(response.phase, response.progress);
      return;
    }
    this.#pending.delete(requestId);
    pending.resolve(response);
  }

  #failAll(failure: OperationFailure): void {
    for (const pending of this.#pending.values()) pending.reject(failure);
    this.#pending.clear();
  }
}

function workerFailure(
  code: 'SILENT_WORKER_UNAVAILABLE' | 'SILENT_WORKER_PROTOCOL_FAILURE'
): OperationFailure {
  return OperationFailure.make({ code, phase: 'silent-worker', scope: 'item' });
}
