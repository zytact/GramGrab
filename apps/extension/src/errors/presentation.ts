import type { FailureCode, RecoveryAction, WarningCode } from './contracts.ts';

export interface FailurePresentation {
  readonly title: string;
  readonly explanation: string;
  readonly actions: readonly RecoveryAction[];
  readonly retry: 'never' | 'once' | 'after-user-action' | 'after-refetch';
  readonly retainSilentInput: boolean;
}

const policy = (
  title: string,
  explanation: string,
  actions: readonly RecoveryAction[],
  retry: FailurePresentation['retry'] = 'never',
  retainSilentInput = false
): FailurePresentation => ({ title, explanation, actions, retry, retainSilentInput });

export const FAILURE_PRESENTATION: Readonly<Record<FailureCode, FailurePresentation>> = {
  INPUT_INVALID_INSTAGRAM_URL: policy('Use an Instagram link', 'Enter a valid Instagram link.', []),
  SOURCE_USERNAME_UNRESOLVED: policy(
    'Source unavailable',
    'Open the source in Instagram to check it.',
    ['open-in-instagram']
  ),
  SOURCE_MEDIA_NOT_FOUND: policy('Source unavailable', 'This source has no downloadable media.', [
    'open-in-instagram',
  ]),
  IG_NOT_AUTHENTICATED: policy(
    'Instagram did not allow access',
    'Sign in to Instagram, then fetch the source again.',
    ['open-in-instagram', 'refetch-source'],
    'after-user-action'
  ),
  IG_ACCESS_FORBIDDEN: policy(
    'Instagram did not allow access',
    'Open the source in Instagram, then fetch it again.',
    ['open-in-instagram', 'refetch-source'],
    'after-user-action'
  ),
  IG_RATE_LIMITED: policy(
    'Instagram is limiting requests',
    'Wait a while before fetching this source again.',
    ['refetch-source'],
    'after-user-action'
  ),
  IG_RESPONSE_SHAPE_UNKNOWN: policy(
    "Instagram's format has changed",
    'GramGrab needs an update to understand this response.',
    ['copy-diagnostics']
  ),
  IG_REQUEST_REJECTED: policy(
    'GramGrab could not request this content',
    'Open the source or copy diagnostics for support.',
    ['open-in-instagram', 'copy-diagnostics']
  ),
  SOURCE_NETWORK_FAILED: policy(
    'Connection problem',
    'Check your connection, then fetch the source again.',
    ['refetch-source'],
    'once'
  ),
  SOURCE_SERVER_FAILED: policy(
    'Connection problem',
    'Instagram did not respond successfully. Fetch the source again later.',
    ['refetch-source'],
    'once'
  ),
  SOURCE_UNEXPECTED_FAILURE: policy(
    'Source unavailable',
    'GramGrab could not fetch this source.',
    ['refetch-source', 'copy-diagnostics'],
    'once'
  ),
  MEDIA_URL_EXPIRED: policy(
    'Media link expired',
    'Fetch the source again to get a fresh media link.',
    ['refetch-source'],
    'after-refetch'
  ),
  MEDIA_NOT_FOUND: policy(
    'Media is no longer available',
    'Fetch the source again or open it in Instagram.',
    ['refetch-source', 'open-in-instagram'],
    'after-refetch'
  ),
  MEDIA_DASH_ONLY_UNSUPPORTED: policy(
    'Instant video format unsupported',
    'This Instant only provides DASH video, which GramGrab cannot export yet.',
    ['copy-diagnostics']
  ),
  INSTANT_NOT_ACTIVE: policy(
    'Instant no longer active',
    'This Instant is no longer present in the active feed.',
    ['refetch-source'],
    'after-refetch'
  ),
  MEDIA_NETWORK_FAILED: policy(
    'Could not load the media',
    'Retry once, then fetch the source again.',
    ['retry-operation', 'refetch-source'],
    'once'
  ),
  MEDIA_RESPONSE_EMPTY: policy(
    'Could not load the media',
    'Retry once, then fetch the source again.',
    ['retry-operation', 'refetch-source'],
    'once'
  ),
  BROWSER_DOWNLOAD_BLOCKED: policy(
    'Browser blocked the download',
    'Allow downloads for GramGrab, then retry.',
    ['retry-operation'],
    'after-user-action'
  ),
  BROWSER_DOWNLOAD_NETWORK_FAILED: policy(
    'Download could not start',
    'Retry once, then fetch the source again.',
    ['retry-operation', 'refetch-source'],
    'once'
  ),
  BROWSER_DOWNLOAD_FILE_FAILED: policy(
    'Browser could not save the file',
    'Check storage and download permissions, then retry.',
    ['retry-operation'],
    'after-user-action'
  ),
  DOWNLOAD_UNEXPECTED_FAILURE: policy(
    'Download could not start',
    'Retry once or copy diagnostics.',
    ['retry-operation', 'copy-diagnostics'],
    'once'
  ),
  FRAME_METADATA_UNAVAILABLE: policy(
    'Could not prepare the video',
    'Retry or download the original video.',
    ['retry-operation', 'download-original'],
    'once'
  ),
  FRAME_TIMEOUT: policy(
    'Frame export timed out',
    'Retry or download the original video.',
    ['retry-operation', 'download-original'],
    'once'
  ),
  FRAME_NO_DECODABLE_FRAME: policy(
    'Frame export is not supported for this video',
    'Download the original video instead.',
    ['download-original']
  ),
  FRAME_CANVAS_UNAVAILABLE: policy(
    'Frame export is not available in this browser',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  FRAME_IMAGE_ENCODING_FAILED: policy(
    'Frame export is not available in this browser',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  FRAME_UNEXPECTED_FAILURE: policy(
    'Frame export failed',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_STORAGE_UNAVAILABLE: policy(
    'Silent downloads need temporary browser storage',
    'Reload GramGrab or download the originals.',
    ['reload-workspace', 'download-original']
  ),
  SILENT_STORAGE_CAPACITY_EXCEEDED: policy(
    'Not enough temporary storage',
    'Free browser storage, retry, or download the original.',
    ['retry-operation', 'download-original'],
    'after-user-action',
    true
  ),
  SILENT_STORAGE_READ_FAILED: policy(
    'Could not reopen the cached video',
    'Fetch the source again or download the original.',
    ['refetch-source', 'download-original']
  ),
  SILENT_STORAGE_WRITE_FAILED: policy(
    'Could not prepare temporary storage',
    'Retry once or download the original.',
    ['retry-operation', 'download-original'],
    'once',
    true
  ),
  SILENT_SOURCE_NO_VIDEO: policy(
    'This video cannot be processed',
    'Download the original video instead.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_INPUT_INSPECTION_FAILED: policy(
    'This video cannot be processed',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_COPY_FAILED: policy(
    'Fast audio removal failed',
    'Try approved re-encoding or download the original.',
    ['try-reencode', 'download-original'],
    'after-user-action',
    true
  ),
  SILENT_H264_ENCODER_UNAVAILABLE: policy(
    'This browser cannot create the silent video',
    'Download the original video instead.',
    ['download-original']
  ),
  SILENT_SOURCE_CONVERSION_UNSUPPORTED: policy(
    'This video cannot be converted',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_REENCODE_FAILED: policy(
    'Could not create the silent video',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_UNEXPECTED_FAILURE: policy(
    'Could not create the silent video',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_OUTPUT_NO_VIDEO: policy(
    'We could not verify the silent video',
    'The invalid output was discarded. Download the original or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_OUTPUT_HAS_AUDIO: policy(
    'We could not verify the silent video',
    'The invalid output was discarded. Download the original or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
  SILENT_WORKER_UNAVAILABLE: policy(
    'Media processing stopped',
    'Retry with a fresh worker or download the original.',
    ['retry-operation', 'download-original'],
    'once',
    true
  ),
  SILENT_WORKER_PROTOCOL_FAILURE: policy(
    'Media processing failed',
    'Download the original video or copy diagnostics.',
    ['download-original', 'copy-diagnostics']
  ),
};

export const WARNING_PRESENTATION: Readonly<Record<WarningCode, string>> = {
  HISTORY_SAVE_FAILED: 'Download started, but history could not be saved.',
  SILENT_TEMPORARY_FILE_CLEANUP_UNCONFIRMED:
    'Download started, but temporary-file cleanup could not be confirmed.',
};

export function retryable(code: FailureCode, retryCount: number): boolean {
  const rule = FAILURE_PRESENTATION[code].retry;
  return rule === 'once' ? retryCount === 0 : rule === 'after-user-action';
}
