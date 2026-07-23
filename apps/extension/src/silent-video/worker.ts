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
import { cleanFailedOutput, inspectSilentVideo, processSilentVideo } from './engine.ts';
import { cacheInput, readInput, removeOutput, outputName } from './opfs.ts';
import { OperationFailure, diagnosticCause } from '../errors/contracts.ts';

declare const self: DedicatedWorkerGlobalScope;

function post(response: SilentWorkerResponse): void {
  self.postMessage(response);
}

async function handleRequest(request: Awaited<ReturnType<typeof decodeSilentWorkerRequest>>) {
  if (request._tag === 'inspect') {
    post(
      SilentProgress.make({
        operationId: request.operationId,
        requestId: request.requestId,
        phase: 'inspecting',
        progress: 0,
      })
    );
    const file = request.useCachedInput
      ? await readInput(request.operationId)
      : await cacheInput(request.operationId, request.url, progress =>
          post(
            SilentProgress.make({
              operationId: request.operationId,
              requestId: request.requestId,
              phase: 'inspecting',
              progress,
            })
          )
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
    progress =>
      post(
        SilentProgress.make({
          operationId: request.operationId,
          requestId: request.requestId,
          phase: 'processing',
          progress,
        })
      )
  );
  post(
    SilentProgress.make({
      operationId: request.operationId,
      requestId: request.requestId,
      phase: 'validating',
      progress: 1,
    })
  );
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
    let request: Awaited<ReturnType<typeof decodeSilentWorkerRequest>>;
    try {
      request = await decodeSilentWorkerRequest(event.data);
    } catch {
      return;
    }
    try {
      await handleRequest(request);
    } catch (cause) {
      const failure =
        cause instanceof OperationFailure
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
