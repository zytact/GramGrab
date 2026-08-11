import { Either } from 'effect';
import { DownloadAcceptedResult, DownloadFailedResult } from '../download/contracts.ts';
import type { AttemptEntry, AttemptOperation } from '../download/attempt.ts';
import { isOperationFailure, OperationWarning } from '../errors/contracts.ts';
import {
  normalizeBrowserDownloadFailure,
  normalizeWhatsAppCaptureFailure,
  normalizeWhatsAppSilentFailure,
} from '../errors/normalize.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import { browser } from '../lib/browser.ts';
import { isAcceptedHistorySaved, type WhatsAppCaptureHandle } from './capture.ts';
import { silentProgressMessage } from '../silent-video/progress.ts';
import { createWhatsAppSilentVideo, type WhatsAppSilentProgress } from './mute.ts';
import { fitsWithinWhatsAppLease, fitsWithinWhatsAppPeakMemory } from './lease.ts';

const WHATSAPP_TERMINAL_OPERATION_ESTIMATE_MS = 30_000;

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

function monitorAcceptedDownload(
  downloadId: number,
  retentionDeadline: number,
  onTerminal: () => void
): void {
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    browser.downloads.onChanged.removeListener(onChanged);
    onTerminal();
  };
  const onChanged = (delta: { id: number; state?: { current?: string } }) => {
    if (
      delta.id === downloadId &&
      (delta.state?.current === 'complete' || delta.state?.current === 'interrupted')
    )
      cleanup();
  };
  const timer = globalThis.setTimeout(
    () => {
      if (settled) return;
      void browser.downloads.cancel(downloadId).catch(() => undefined);
      cleanup();
    },
    Math.max(0, retentionDeadline - Date.now())
  );
  browser.downloads.onChanged.addListener(onChanged);
}

export async function exportWhatsAppFrame(
  handle: WhatsAppCaptureHandle,
  operation: AttemptOperation
) {
  let frameUrl: string | undefined;
  try {
    if (
      !fitsWithinWhatsAppLease({
        now: Date.now(),
        deadline: handle.descriptor.retentionDeadline,
        estimatedDurationMs: WHATSAPP_TERMINAL_OPERATION_ESTIMATE_MS,
      })
    ) {
      handle.release();
      return DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeWhatsAppCaptureFailure('retention-expired'),
      });
    }
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
    const downloadId = await browser.downloads.download({
      url: frameUrl,
      filename: operation.filename,
      saveAs: false,
    });
    const pendingFrameUrl = frameUrl;
    monitorAcceptedDownload(downloadId, handle.descriptor.retentionDeadline, () =>
      URL.revokeObjectURL(pendingFrameUrl)
    );
    handle.release();
    frameUrl = undefined;
    const response = await browser.runtime
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
      .catch(() => undefined);
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(isAcceptedHistorySaved(response)
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
    const preflight = {
      now: Date.now(),
      deadline: handle.descriptor.retentionDeadline,
      estimatedDurationMs: WHATSAPP_TERMINAL_OPERATION_ESTIMATE_MS,
      inputBytes: handle.descriptor.byteLength,
      outputBytes: handle.descriptor.byteLength,
    };
    const leaseFits = fitsWithinWhatsAppLease(preflight);
    const memoryFits = fitsWithinWhatsAppPeakMemory(preflight);
    if (!leaseFits || !memoryFits) {
      handle.release();
      return DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: memoryFits
          ? normalizeWhatsAppCaptureFailure('retention-expired')
          : normalizeWhatsAppSilentFailure('SILENT_MEMORY_CAPACITY_EXCEEDED', 'silent-reencode'),
      });
    }

    const silent = await createWhatsAppSilentVideo(handle.snapshot.blob, {
      retentionDeadline: handle.descriptor.retentionDeadline,
      ...(onProgress ? { onProgress } : {}),
    });
    if (Date.now() >= handle.descriptor.retentionDeadline) {
      handle.release();
      return DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeWhatsAppCaptureFailure('retention-expired'),
      });
    }
    silentUrl = URL.createObjectURL(silent);
    if (Date.now() >= handle.descriptor.retentionDeadline) {
      URL.revokeObjectURL(silentUrl);
      silentUrl = undefined;
      handle.release();
      return DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeWhatsAppCaptureFailure('retention-expired'),
      });
    }
    const downloadId = await browser.downloads.download({
      url: silentUrl,
      filename: operation.filename,
      saveAs: false,
    });
    const pendingSilentUrl = silentUrl;
    monitorAcceptedDownload(downloadId, handle.descriptor.retentionDeadline, () =>
      URL.revokeObjectURL(pendingSilentUrl)
    );
    silentUrl = undefined;
    handle.release();
    onProgress?.('downloading', 1);
    const response = await browser.runtime
      .sendMessage({
        type: 'RECORD_WHATSAPP_HISTORY',
        receipt: {
          source: 'whatsapp',
          mediaKind: 'video',
          timestamp: Date.now(),
          savedFilename: operation.filename,
          outcome: 'accepted',
        },
      })
      .catch(() => undefined);
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(isAcceptedHistorySaved(response)
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
