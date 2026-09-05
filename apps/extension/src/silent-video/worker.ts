/// <reference lib="webworker" />

import {
  decodeSilentWorkerRequest,
  SilentInspected,
  SilentProcessed,
  SilentProgress,
  SilentReleased,
  SilentWorkerError,
  type SilentPhase,
  type SilentWorkerResponse,
} from './contracts.ts';
import { cleanFailedOutput, inspectSilentVideo, processSilentVideo } from './engine.ts';
import { cacheInput, readInput, removeOutput, outputName } from './opfs.ts';
import { throttleProgress } from './throttle.ts';
import { isOperationFailure, OperationFailure, diagnosticCause } from '../errors/contracts.ts';

declare const self: DedicatedWorkerGlobalScope;

type SilentWorkerRequest = Awaited<ReturnType<typeof decodeSilentWorkerRequest>>;

function post(response: SilentWorkerResponse): void {
  self.postMessage(response);
}

/** One throttle per request, because several requests can be in flight in the same worker. */
function progressFor(request: SilentWorkerRequest) {
  return throttleProgress<SilentPhase>(tick =>
    post(
      SilentProgress.make({
        operationId: request.operationId,
        requestId: request.requestId,
        phase: tick.phase,
        progress: tick.progress,
      })
    )
  );
}

async function handleRequest(request: SilentWorkerRequest) {
  const emitProgress = progressFor(request);
  if (request._tag === 'inspect') {
    emitProgress({ phase: 'inspecting', progress: 0 });
    const file = request.useCachedInput
      ? await readInput(request.operationId)
      : await cacheInput(request.operationId, request.url, progress =>
          emitProgress({ phase: 'inspecting', progress })
        );
    post(
      SilentInspected.make({
        preflight: await inspectSilentVideo(request.operationId, request.requestId, file),
      })
    );
    return;
  }
  if (request._tag === 'release') {
    await removeOutput(outputName(request.operationId));
    post(SilentReleased.make({ operationId: request.operationId, requestId: request.requestId }));
    return;
  }
  const result = await processSilentVideo(
    request.operationId,
    request.requestId,
    request.transcode,
    progress => emitProgress({ phase: 'processing', progress })
  );
  emitProgress({ phase: 'validating', progress: 1 });
  post(
    SilentProcessed.make({
      operationId: request.operationId,
      requestId: request.requestId,
      ...result,
    })
  );
}

self.addEventListener('message', event => {
  void (async () => {
    let request: SilentWorkerRequest;
    try {
      request = await decodeSilentWorkerRequest(event.data);
    } catch {
      return;
    }
    try {
      await handleRequest(request);
    } catch (cause) {
      const failure = isOperationFailure(cause)
        ? cause
        : OperationFailure.make({
            code: 'SILENT_UNEXPECTED_FAILURE',
            phase: 'silent-worker',
            scope: 'item',
            cause: diagnosticCause(cause),
          });
      await cleanFailedOutput(outputName(request.operationId), failure).catch(() => undefined);
      post(
        SilentWorkerError.make({
          operationId: request.operationId,
          requestId: request.requestId,
          failure,
        })
      );
    }
  })();
});
