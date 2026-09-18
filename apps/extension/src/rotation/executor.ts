import type { RotatedOperation } from '../download/attempt.ts';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  type DownloadOperationResult,
} from '../download/contracts.ts';
import { HttpError, NetworkError } from '../effect/errors.ts';
import {
  diagnosticCause,
  isOperationFailure,
  OperationFailure,
  OperationWarning,
} from '../errors/contracts.ts';
import {
  normalizeBrowserDownloadFailure,
  normalizeMediaTransferFailure,
} from '../errors/normalize.ts';
import { browser } from '../lib/browser.ts';
import { sendMessage } from '../messaging/send.ts';
import type { Rotation } from './contracts.ts';
import { rotateImage, rotateVideo } from './media.ts';

async function fetchMedia(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit' });
  } catch (cause) {
    throw normalizeMediaTransferFailure(new NetworkError({ cause }));
  }
  if (!response.ok)
    throw normalizeMediaTransferFailure(
      new HttpError({ status: response.status, message: response.statusText })
    );
  return response.blob();
}

async function rotate(media: Blob, mediaType: 'image' | 'video', rotation: Rotation) {
  try {
    return await (mediaType === 'video'
      ? rotateVideo(media, rotation)
      : rotateImage(media, rotation));
  } catch (cause) {
    throw OperationFailure.make({
      code: 'ROTATION_FAILED',
      phase: 'rotation',
      scope: 'item',
      cause: diagnosticCause(cause),
    });
  }
}

/** Frees a document-made download's bytes once the browser stops reading them. */
function revokeWhenSettled(downloadId: number, url: string): void {
  const release = () => {
    browser.downloads.onChanged.removeListener(listener);
    URL.revokeObjectURL(url);
  };
  const listener = (delta: { id: number; state?: { current?: string } }) => {
    if (delta.id === downloadId && delta.state?.current && delta.state.current !== 'in_progress')
      release();
  };
  browser.downloads.onChanged.addListener(listener);
  void browser.downloads.search({ id: downloadId }).then(
    ([item]) => item?.state && item.state !== 'in_progress' && release(),
    () => undefined
  );
}

async function download(file: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    revokeWhenSettled(await browser.downloads.download({ url, filename, saveAs: false }), url);
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw normalizeBrowserDownloadFailure(cause);
  }
}

/**
 * Downloads a direct-mode item turned by its requested rotation. The turn happens in the calling
 * document because it needs canvas and media APIs, and history records the rotation so a
 * redownload reproduces it.
 */
export async function executeRotatedExport(
  operation: RotatedOperation,
  sourceUrl: string,
  originKind: 'source' | 'instants'
): Promise<DownloadOperationResult> {
  const ids = { operationId: operation.operationId, requestId: operation.requestId };
  try {
    const media = await fetchMedia(operation.url);
    await download(
      await rotate(media, operation.mediaType, operation.rotation),
      operation.filename
    );
  } catch (cause) {
    return DownloadFailedResult.make({
      ...ids,
      status: 'failed',
      failure: isOperationFailure(cause) ? cause : normalizeMediaTransferFailure(cause),
    });
  }
  const recorded = await sendMessage({
    type: 'RECORD_DIRECT_EXPORT',
    sourceUrl,
    originKind,
    item: operation,
  }).catch(() => ({ warning: 'HISTORY_SAVE_FAILED' as const }));
  return DownloadAcceptedResult.make({
    ...ids,
    status: 'started',
    ...(recorded.warning ? { warning: OperationWarning.make({ code: recorded.warning }) } : {}),
  });
}
