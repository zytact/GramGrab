import type { RequestId } from '../download/contracts.ts';
import {
  decodeSilentWorkerResponse,
  InspectSilentVideo,
  ProcessSilentVideo,
  ReleaseSilentVideo,
  type SilentPreflight,
  type SilentWorkerResponse,
} from './contracts.ts';

type Pending = {
  resolve: (response: SilentWorkerResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (phase: string, progress: number) => void;
};

export class SilentVideoClient {
  readonly #worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  readonly #pending = new Map<string, Pending>();

  constructor() {
    this.#worker.addEventListener('message', event => void this.#receive(event.data));
    this.#worker.addEventListener('error', () =>
      this.#failAll('The media worker stopped unexpectedly.')
    );
  }

  async inspect(requestId: RequestId, url: string): Promise<SilentPreflight> {
    const response = await this.#request(requestId, InspectSilentVideo.make({ requestId, url }));
    if (response._tag !== 'inspected')
      throw new Error(
        response._tag === 'SilentWorkerError' ? response.reason : 'Invalid inspection result.'
      );
    return response.preflight;
  }

  async process(
    requestId: RequestId,
    url: string,
    transcode: boolean,
    onProgress: Pending['onProgress']
  ) {
    const response = await this.#request(
      requestId,
      ProcessSilentVideo.make({ requestId, url, transcode }),
      onProgress
    );
    if (response._tag !== 'processed')
      throw new Error(
        response._tag === 'SilentWorkerError' ? response.reason : 'Invalid processing result.'
      );
    return response;
  }

  release(requestId: RequestId): Promise<unknown> {
    return this.#request(requestId, ReleaseSilentVideo.make({ requestId }));
  }

  close(): void {
    this.#worker.terminate();
    this.#failAll('The media worker was closed.');
  }

  #request(
    requestId: RequestId,
    message: object,
    onProgress?: Pending['onProgress']
  ): Promise<SilentWorkerResponse> {
    if (this.#pending.has(requestId))
      return Promise.reject(new Error('A media request with this ID is already active.'));
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
      this.#worker.postMessage(message);
    });
  }

  async #receive(value: unknown): Promise<void> {
    let response: SilentWorkerResponse;
    try {
      response = await decodeSilentWorkerResponse(value);
    } catch {
      this.#failAll('The media worker returned an invalid response.');
      return;
    }
    const requestId =
      response._tag === 'inspected' ? response.preflight.requestId : response.requestId;
    const pending = this.#pending.get(requestId);
    if (!pending) {
      this.#failAll('The media worker returned an unknown or duplicate request ID.');
      return;
    }
    if (response._tag === 'progress') {
      pending.onProgress?.(response.phase, response.progress);
      return;
    }
    this.#pending.delete(requestId);
    pending.resolve(response);
  }

  #failAll(reason: string): void {
    for (const pending of this.#pending.values()) pending.reject(new Error(reason));
    this.#pending.clear();
  }
}
