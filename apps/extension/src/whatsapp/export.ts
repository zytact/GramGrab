import { Either } from 'effect';
import { DownloadAcceptedResult, DownloadFailedResult } from '../download/contracts.ts';
import { OperationWarning } from '../errors/contracts.ts';
import {
  normalizeBrowserDownloadFailure,
  normalizeWhatsAppCaptureFailure,
} from '../errors/normalize.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import type { AttemptOperation } from '../download/attempt.ts';
import { browser } from '../lib/browser.ts';
import type { WhatsAppCaptureHandle } from './capture.ts';

export async function exportWhatsAppFrame(
  handle: WhatsAppCaptureHandle,
  operation: AttemptOperation
) {
  let frameUrl: string | undefined;
  try {
    const captured = await captureFrameFromSource(
      handle.snapshot.objectUrl(),
      operation.frameTimestampSeconds ?? 0
    );
    if (Either.isLeft(captured)) {
      handle.release();
      return DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeWhatsAppCaptureFailure('transfer-failed'),
      });
    }

    frameUrl = URL.createObjectURL(captured.right);
    await browser.downloads.download({
      url: frameUrl,
      filename: operation.filename,
      saveAs: false,
    });
    handle.release();
    URL.revokeObjectURL(frameUrl);
    frameUrl = undefined;
    const response = (await browser.runtime
      .sendMessage({
        type: 'RECORD_WHATSAPP_HISTORY',
        receipt: {
          source: 'whatsapp',
          mediaKind: 'photo',
          timestamp: Date.now(),
          savedFilename: operation.filename,
          outcome: 'accepted',
        },
      })
      .catch(() => undefined)) as { saved?: unknown } | undefined;
    handle.release();
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(response?.saved === true
        ? {}
        : { warning: OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' }) }),
    });
  } catch (cause) {
    handle.release();
    return DownloadFailedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'failed',
      failure: normalizeBrowserDownloadFailure(cause, 'whatsapp'),
    });
  } finally {
    if (frameUrl) URL.revokeObjectURL(frameUrl);
  }
}
