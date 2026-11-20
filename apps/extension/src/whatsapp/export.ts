import { Either } from 'effect';
import { DownloadAcceptedResult, DownloadFailedResult } from '../download/contracts.ts';
import {
  executorFor,
  isModifiedOperation,
  type AttemptEntry,
  type AttemptOperation,
} from '../download/attempt.ts';
import {
  isOperationFailure,
  OperationWarning,
  type OperationFailure,
} from '../errors/contracts.ts';
import {
  normalizeBrowserDownloadFailure,
  normalizeWhatsAppCaptureFailure,
  normalizeWhatsAppEditFailure,
  normalizeWhatsAppSilentFailure,
} from '../errors/normalize.ts';
import { captureFrameFromSource } from '../frame-export/capture-source.ts';
import { browser } from '../lib/browser.ts';
import { sendMessage } from '../messaging/send.ts';
import { revokeWhenSettled } from '../rotation/executor.ts';
import { modifyImage, rotateVideo } from '../rotation/media.ts';
import { silentProgressMessage } from '../silent-video/progress.ts';
import type { WhatsAppCaptureHandle } from './capture.ts';

export type WhatsAppExportProgress = (phase: string, progress: number) => void;

type EditedExecutor = Exclude<ReturnType<typeof executorFor>, 'direct'>;

export function whatsappExportProgressMessage(
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

function videoFailure(cause: unknown, operation: AttemptOperation): OperationFailure {
  if (operation.crop) return normalizeWhatsAppEditFailure('crop');
  if (isOperationFailure(cause) && cause.code === 'SILENT_SOURCE_NO_VIDEO')
    return normalizeWhatsAppSilentFailure(cause.code, 'silent-inspection');
  if (isOperationFailure(cause) && cause.code === 'SILENT_SOURCE_CONVERSION_UNSUPPORTED')
    return normalizeWhatsAppSilentFailure(cause.code, 'silent-reencode');
  return normalizeWhatsAppSilentFailure('SILENT_REENCODE_FAILED', 'silent-reencode');
}

async function frameOutput(source: Blob, operation: AttemptOperation): Promise<Blob> {
  const frame = await captureFrameFromSource(
    source,
    operation.frameTimestampSeconds ?? 0,
    operation
  );
  if (Either.isLeft(frame)) throw normalizeWhatsAppCaptureFailure('transfer-failed');
  return frame.right;
}

async function modifiedOutput(source: Blob, operation: AttemptOperation): Promise<Blob> {
  const failure = normalizeWhatsAppEditFailure(operation.crop ? 'crop' : 'rotation');
  if (!isModifiedOperation(operation)) throw failure;
  try {
    return operation.mediaType === 'image'
      ? await modifyImage(source, operation)
      : await rotateVideo(source, operation.rotation);
  } catch {
    throw failure;
  }
}

async function videoOutput(
  source: Blob,
  operation: AttemptOperation,
  onProgress: WhatsAppExportProgress
): Promise<Blob> {
  try {
    const { processedVideo } = await import('./processed-video.ts');
    return await processedVideo(source, operation, onProgress);
  } catch (cause) {
    throw videoFailure(cause, operation);
  }
}

function editedOutput(
  source: Blob,
  operation: AttemptOperation,
  executor: EditedExecutor,
  onProgress: WhatsAppExportProgress
): Promise<Blob> {
  switch (executor) {
    case 'frame':
      return frameOutput(source, operation);
    case 'modified':
      return modifiedOutput(source, operation);
    case 'video':
      return videoOutput(source, operation, onProgress);
  }
}

async function recordReceipt(handle: WhatsAppCaptureHandle, operation: AttemptOperation) {
  const response = await sendMessage({
    type: 'RECORD_WHATSAPP_HISTORY',
    receipt: {
      source: 'whatsapp',
      mediaKind: operation.mode === 'frame' ? 'photo' : handle.descriptor.kind,
      timestamp: Date.now(),
      savedFilename: operation.filename,
      outcome: 'accepted',
    },
  }).catch(() => undefined);
  return response?.saved ? undefined : OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' });
}

export function exportWhatsAppStatus(
  handle: WhatsAppCaptureHandle,
  operation: AttemptOperation,
  onProgress: WhatsAppExportProgress = () => {}
) {
  const executor = executorFor(operation);
  if (executor === 'direct') return handle.download();
  return exportEdited(handle, operation, executor, onProgress);
}

async function exportEdited(
  handle: WhatsAppCaptureHandle,
  operation: AttemptOperation,
  executor: EditedExecutor,
  onProgress: WhatsAppExportProgress
) {
  const ids = { operationId: operation.operationId, requestId: operation.requestId };
  let url: string | undefined;
  try {
    url = URL.createObjectURL(
      await editedOutput(handle.snapshot.blob, operation, executor, onProgress)
    );
    const downloadId = await browser.downloads.download({
      url,
      filename: operation.filename,
      saveAs: false,
    });
    const acceptedUrl = url;
    revokeWhenSettled(downloadId, acceptedUrl);
    url = undefined;
    handle.release();
    onProgress('downloading', 1);
    const warning = await recordReceipt(handle, operation);
    return DownloadAcceptedResult.make({
      ...ids,
      status: 'started',
      ...(warning ? { warning } : {}),
    });
  } catch (cause) {
    handle.release();
    return DownloadFailedResult.make({
      ...ids,
      status: 'failed',
      failure: isOperationFailure(cause)
        ? cause
        : normalizeBrowserDownloadFailure(cause, 'whatsapp'),
    });
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
