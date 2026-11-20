import { Either } from 'effect';
import { DownloadAcceptedResult, DownloadFailedResult } from '../download/contracts.ts';
import type { AttemptEntry, AttemptOperation } from '../download/attempt.ts';
import { isOperationFailure, OperationWarning } from '../errors/contracts.ts';
import {
  normalizeBrowserDownloadFailure,
  normalizeWhatsAppCaptureFailure,
} from '../errors/normalize.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import { browser } from '../lib/browser.ts';
import { sendMessage } from '../messaging/send.ts';
import type { WhatsAppCaptureHandle } from './capture.ts';
import { silentProgressMessage } from '../silent-video/progress.ts';
import { createWhatsAppSilentVideo, type WhatsAppSilentProgress } from './mute.ts';

export function whatsappSilentProgressMessage(
  operation: AttemptOperation,
  phase: string,
  progress: number
): string | undefined {
  const entry: AttemptEntry = {
    operation,
    outcome: { status: 'pending', phase, progress },
    executionCount: 1,
    manualRetryCount: 0,
  };
  return silentProgressMessage([entry]);
}

function monitorAcceptedDownload(downloadId: number, onTerminal: () => void): void {
  const onChanged = (delta: { id: number; state?: { current?: string } }) => {
    if (
      delta.id !== downloadId ||
      (delta.state?.current !== 'complete' && delta.state?.current !== 'interrupted')
    )
      return;
    browser.downloads.onChanged.removeListener(onChanged);
    onTerminal();
  };
  browser.downloads.onChanged.addListener(onChanged);
}

export async function exportWhatsAppFrame(
  handle: WhatsAppCaptureHandle,
  operation: AttemptOperation
) {
  let frameUrl: string | undefined;
  try {
    const captured = await captureFrameFromSource(
      handle.snapshot.blob,
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
    const downloadId = await browser.downloads.download({
      url: frameUrl,
      filename: operation.filename,
      saveAs: false,
    });
    const pendingFrameUrl = frameUrl;
    monitorAcceptedDownload(downloadId, () => URL.revokeObjectURL(pendingFrameUrl));
    handle.release();
    frameUrl = undefined;
    const response = await sendMessage({
      type: 'RECORD_WHATSAPP_HISTORY',
      receipt: {
        source: 'whatsapp',
        mediaKind: 'photo',
        timestamp: Date.now(),
        savedFilename: operation.filename,
        outcome: 'accepted',
      },
    }).catch(() => undefined);
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(response?.saved
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

export async function exportWhatsAppSilent(
  handle: WhatsAppCaptureHandle,
  operation: AttemptOperation,
  onProgress?: WhatsAppSilentProgress
) {
  let silentUrl: string | undefined;
  try {
    const silent = await createWhatsAppSilentVideo(handle.snapshot.blob, onProgress);
    silentUrl = URL.createObjectURL(silent);
    const downloadId = await browser.downloads.download({
      url: silentUrl,
      filename: operation.filename,
      saveAs: false,
    });
    const pendingSilentUrl = silentUrl;
    monitorAcceptedDownload(downloadId, () => URL.revokeObjectURL(pendingSilentUrl));
    silentUrl = undefined;
    handle.release();
    onProgress?.('downloading', 1);
    const response = await sendMessage({
      type: 'RECORD_WHATSAPP_HISTORY',
      receipt: {
        source: 'whatsapp',
        mediaKind: 'video',
        timestamp: Date.now(),
        savedFilename: operation.filename,
        outcome: 'accepted',
      },
    }).catch(() => undefined);
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(response?.saved
        ? {}
        : { warning: OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' }) }),
    });
  } catch (cause) {
    handle.release();
    return DownloadFailedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'failed',
      failure: isOperationFailure(cause)
        ? cause
        : normalizeBrowserDownloadFailure(cause, 'whatsapp'),
    });
  } finally {
    if (silentUrl) URL.revokeObjectURL(silentUrl);
  }
}
