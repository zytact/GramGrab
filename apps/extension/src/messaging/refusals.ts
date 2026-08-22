import { DownloadMediaResponse } from '../download/contracts.ts';
import { OperationFailure } from '../errors/contracts.ts';
import { historyFailure } from '../errors/normalize.ts';
import type { BackgroundMessageType, MessageResponse } from './contracts.ts';

const UNREADABLE_REQUEST = 'GramGrab could not read this request. Reload the extension.';

/**
 * What the background worker answers when it recognizes a message type but cannot read its
 * payload, which is what version skew looks like from the receiving side. Every answerable type
 * states its own refusal so the answer is a deliberate part of the contract rather than silence,
 * and every refusal reuses an existing failure code from that message's own subsystem: an
 * unreadable request is an extension boundary failure, not a new class of error.
 */
export const MESSAGE_REFUSALS: {
  readonly [T in BackgroundMessageType]: () => MessageResponse<T>;
} = {
  FETCH_MEDIA: () => ({ failure: sourceRefusal() }),
  FETCH_INSTANTS: () => ({ failure: sourceRefusal() }),
  GET_PREVIEW_URL: () => ({ previewUrl: undefined, failure: mediaRefusal() }),
  FETCH_VIDEO_BLOB: () => ({ dataUrl: undefined, failure: mediaRefusal() }),
  DOWNLOAD_MEDIA: () =>
    DownloadMediaResponse.make({
      results: [],
      failure: OperationFailure.make({
        code: 'DOWNLOAD_UNEXPECTED_FAILURE',
        phase: 'browser-download',
        scope: 'batch',
      }),
    }),
  GET_DOWNLOAD_HISTORY: () => ({ entries: [], failure: historyFailure('HISTORY_STORE_FAILED') }),
  CLEAR_DOWNLOAD_HISTORY: () => ({ failure: historyFailure('HISTORY_STORE_FAILED') }),
  DELETE_HISTORY_ENTRY: () => ({ entries: [], failure: historyFailure('HISTORY_STORE_FAILED') }),
  REDOWNLOAD_HISTORY_ENTRY: () => ({ failure: historyFailure('HISTORY_STORE_FAILED') }),
  RECORD_WHATSAPP_HISTORY: () => ({ warning: 'HISTORY_SAVE_FAILED' }),
  DELETE_WHATSAPP_HISTORY_RECEIPT: () => ({
    entries: [],
    failure: historyFailure('HISTORY_STORE_FAILED'),
  }),
  RECORD_FRAME_EXPORT: () => ({ warning: 'HISTORY_SAVE_FAILED' }),
  DOWNLOAD_FRAME_EXPORT: () => ({ failure: downloadRefusal() }),
  RECORD_SILENT_EXPORT: () => ({ warning: 'HISTORY_SAVE_FAILED' }),
  DEBUG_SHAPE: () => ({ error: UNREADABLE_REQUEST }),
  DOWNLOAD_DEBUG_JSON: () => ({ failure: downloadRefusal() }),
};

function sourceRefusal() {
  return OperationFailure.make({
    code: 'SOURCE_UNEXPECTED_FAILURE',
    phase: 'source',
    scope: 'batch',
  });
}

function mediaRefusal() {
  return OperationFailure.make({
    code: 'MEDIA_UNEXPECTED_FAILURE',
    phase: 'media-transfer',
    scope: 'item',
  });
}

function downloadRefusal() {
  return OperationFailure.make({
    code: 'DOWNLOAD_UNEXPECTED_FAILURE',
    phase: 'browser-download',
    scope: 'item',
  });
}
