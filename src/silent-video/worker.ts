/// <reference lib="webworker" />

import {
  decodeSilentWorkerRequest,
  SilentInspected,
  SilentProcessed,
  SilentProgress,
  SilentReleased,
  SilentWorkerError,
  type SilentWorkerResponse,
} from './contracts.ts';
import { inspectSilentVideo, processSilentVideo } from './engine.ts';
import { cacheInput, removeOutput, outputName } from './opfs.ts';

declare const self: DedicatedWorkerGlobalScope;

function post(response: SilentWorkerResponse): void {
  self.postMessage(response);
}

const failurePatterns: readonly [SilentWorkerError['kind'], RegExp][] = [
  ['storage', /storage/],
  ['network', /network|fetch/],
  ['unsupported', /video track|codec|encode/],
  ['validation', /generated file|still contains audio/],
];

function failureKind(cause: unknown): SilentWorkerError['kind'] {
  const detail = cause instanceof Error ? cause.message.toLowerCase() : '';
  return failurePatterns.find(([, pattern]) => pattern.test(detail))?.[0] ?? 'processing';
}

async function handleRequest(request: Awaited<ReturnType<typeof decodeSilentWorkerRequest>>) {
  if (request._tag === 'inspect') {
    post(SilentProgress.make({ requestId: request.requestId, phase: 'inspecting', progress: 0 }));
    const file = await cacheInput(request.requestId, request.url, progress =>
      post(SilentProgress.make({ requestId: request.requestId, phase: 'inspecting', progress }))
    );
    post(
      SilentInspected.make({
        preflight: await inspectSilentVideo(request.requestId, file),
      })
    );
    return;
  }
  if (request._tag === 'release') {
    await removeOutput(outputName(request.requestId));
    post(SilentReleased.make({ requestId: request.requestId }));
    return;
  }
  const result = await processSilentVideo(request.requestId, request.transcode, progress =>
    post(SilentProgress.make({ requestId: request.requestId, phase: 'processing', progress }))
  );
  post(SilentProgress.make({ requestId: request.requestId, phase: 'validating', progress: 1 }));
  post(SilentProcessed.make({ requestId: request.requestId, ...result }));
}

self.addEventListener('message', event => {
  void (async () => {
    let request: Awaited<ReturnType<typeof decodeSilentWorkerRequest>>;
    try {
      request = await decodeSilentWorkerRequest(event.data);
    } catch {
      return;
    }
    try {
      await handleRequest(request);
    } catch (cause) {
      await removeOutput(outputName(request.requestId)).catch(() => undefined);
      post(
        SilentWorkerError.make({
          requestId: request.requestId,
          kind: failureKind(cause),
          reason: cause instanceof Error ? cause.message : 'Audio removal could not be completed.',
        })
      );
    }
  })();
});
