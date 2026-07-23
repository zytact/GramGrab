import { Either } from 'effect';
import { browser } from '../lib/browser.ts';
import type { AttemptOperation } from '../download/attempt.ts';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  type DownloadOperationResult,
} from '../download/contracts.ts';
import { OperationWarning } from '../errors/contracts.ts';
import { normalizeFrameFailure } from '../errors/normalize.ts';
import { captureFrameFromSource } from './capture-source.ts';

export type FrameExportPhase = 'frame-metadata' | 'frame-export';

export interface FrameExecutorOptions {
  readonly onPhase?: (phase: FrameExportPhase) => void;
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Invalid frame'))
    );
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Frame read failed')));
    reader.readAsDataURL(blob);
  });
}

export async function executeFrameExport(
  operation: AttemptOperation,
  sourceUrl: string,
  options: FrameExecutorOptions = {}
): Promise<DownloadOperationResult> {
  let mediaObjectUrl: string | undefined;
  try {
    options.onPhase?.('frame-metadata');
    const response = await fetch(operation.url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`Video request failed with status ${response.status}.`);
    mediaObjectUrl = URL.createObjectURL(await response.blob());
    const captured = await captureFrameFromSource(
      mediaObjectUrl,
      operation.frameTimestampSeconds ?? 0
    );
    if (Either.isLeft(captured))
      return DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeFrameFailure(captured.left.reason, captured.left),
      });

    options.onPhase?.('frame-export');
    const downloaded = (await browser.runtime.sendMessage({
      type: 'DOWNLOAD_FRAME_EXPORT',
      dataUrl: await blobAsDataUrl(captured.right),
      sourceUrl,
      item: {
        itemIndex: operation.itemIndex,
        ...(operation.mediaId ? { mediaId: operation.mediaId } : {}),
        url: operation.url,
        filename: operation.filename,
        mediaType: 'video',
        frameTimestampSeconds: operation.frameTimestampSeconds ?? 0,
      },
    })) as { error?: string };
    if (downloaded.error?.startsWith('Frame download failed')) throw new Error(downloaded.error);
    return DownloadAcceptedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'started',
      ...(downloaded.error
        ? { warning: OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' }) }
        : {}),
    });
  } catch (cause) {
    return DownloadFailedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'failed',
      failure: normalizeFrameFailure('unexpected', cause),
    });
  } finally {
    if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
  }
}
