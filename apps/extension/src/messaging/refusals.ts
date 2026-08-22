import { DownloadMediaResponse } from '../download/contracts.ts';
import { OperationFailure } from '../errors/contracts.ts';
import type { BackgroundMessageType, MessageResponse } from './contracts.ts';

const UNREADABLE_REQUEST = 'GramGrab could not read this request. Reload the extension.';

/**
 * What the background worker answers when it recognizes a message type but cannot read its
 * payload, which is what version skew looks like from the receiving side. Every answerable type
 * states its own refusal so the answer is a deliberate part of the contract rather than silence,
 * and every refusal reuses an existing failure code: an unreadable request is an extension
 * boundary failure, not a new class of error.
 */
export const MESSAGE_REFUSALS: {
  readonly [T in BackgroundMessageType]: () => MessageResponse<T>;
} = {
  FETCH_MEDIA: () => ({ failure: sourceRefusal() }),
  FETCH_INSTANTS: () => ({ failure: sourceRefusal() }),
  GET_PREVIEW_URL: () => ({ previewUrl: undefined, error: UNREADABLE_REQUEST }),
  FETCH_VIDEO_BLOB: () => ({ dataUrl: undefined, error: UNREADABLE_REQUEST }),
  DOWNLOAD_MEDIA: () =>
    DownloadMediaResponse.make({
      results: [],
      failure: OperationFailure.make({
        code: 'DOWNLOAD_UNEXPECTED_FAILURE',
        phase: 'browser-download',
        scope: 'batch',
      }),
    }),
  GET_DOWNLOAD_HISTORY: () => ({ entries: [], error: UNREADABLE_REQUEST }),
  CLEAR_DOWNLOAD_HISTORY: () => ({ error: UNREADABLE_REQUEST }),
  DELETE_HISTORY_ENTRY: () => ({ entries: [], error: UNREADABLE_REQUEST }),
  REDOWNLOAD_HISTORY_ENTRY: () => ({ error: UNREADABLE_REQUEST }),
  RECORD_WHATSAPP_HISTORY: () => ({ warning: 'HISTORY_SAVE_FAILED' }),
  DELETE_WHATSAPP_HISTORY_RECEIPT: () => ({
    entries: [],
    error: 'This history entry is invalid.',
  }),
  RECORD_FRAME_EXPORT: () => ({ error: UNREADABLE_REQUEST }),
  DOWNLOAD_FRAME_EXPORT: () => ({ error: UNREADABLE_REQUEST }),
  RECORD_SILENT_EXPORT: () => ({ error: UNREADABLE_REQUEST }),
  DEBUG_SHAPE: () => ({ error: UNREADABLE_REQUEST }),
  DOWNLOAD_DEBUG_JSON: () => ({ error: UNREADABLE_REQUEST }),
};

function sourceRefusal() {
  return OperationFailure.make({
    code: 'SOURCE_UNEXPECTED_FAILURE',
    phase: 'source',
    scope: 'batch',
  });
}
