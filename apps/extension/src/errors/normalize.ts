import {
  OperationFailure,
  diagnosticCause,
  type FailureCode,
  type FailurePhase,
} from './contracts.ts';
import {
  GraphQLRequestFailed,
  HttpError,
  InvalidInstagramUrl,
  MediaNotFound,
  MediaDashOnlyUnsupported,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
  UsernameUnresolved,
} from '../effect/errors.ts';

function failure(
  code: FailureCode,
  phase: FailurePhase,
  cause?: unknown,
  scope: OperationFailure['scope'] = 'item'
): OperationFailure {
  return OperationFailure.make({
    code,
    phase,
    scope,
    ...(cause === undefined ? {} : { cause: diagnosticCause(cause) }),
  });
}

export function normalizeSourceFailure(cause: unknown): OperationFailure {
  if (cause instanceof InvalidInstagramUrl)
    return failure('INPUT_INVALID_INSTAGRAM_URL', 'input', cause, 'batch');
  if (cause instanceof UsernameUnresolved)
    return failure('SOURCE_USERNAME_UNRESOLVED', 'source', cause, 'batch');
  if (cause instanceof MediaNotFound)
    return failure('SOURCE_MEDIA_NOT_FOUND', 'source', cause, 'batch');
  if (cause instanceof MediaDashOnlyUnsupported)
    return failure('MEDIA_DASH_ONLY_UNSUPPORTED', 'source', cause);
  if (cause instanceof RateLimited) return failure('IG_RATE_LIMITED', 'source', cause, 'batch');
  if (cause instanceof ResponseShapeUnknown)
    return failure('IG_RESPONSE_SHAPE_UNKNOWN', 'source', cause, 'batch');
  if (cause instanceof NetworkError)
    return failure('SOURCE_NETWORK_FAILED', 'source', cause, 'batch');
  if (cause instanceof GraphQLRequestFailed || cause instanceof HttpError) {
    if (cause.status === 401) return failure('IG_NOT_AUTHENTICATED', 'source', cause, 'batch');
    if (cause.status === 403) return failure('IG_ACCESS_FORBIDDEN', 'source', cause, 'batch');
    if (cause.status >= 500) return failure('SOURCE_SERVER_FAILED', 'source', cause, 'batch');
    return failure('IG_REQUEST_REJECTED', 'source', cause, 'batch');
  }
  return failure('SOURCE_UNEXPECTED_FAILURE', 'source', cause, 'batch');
}

// downloads.download exposes only runtime.lastError.message in callback-based browsers.
export function normalizeBrowserDownloadFailure(cause: unknown): OperationFailure {
  const message =
    cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  if (/permission|denied|blocked|not allowed/.test(message))
    return failure('BROWSER_DOWNLOAD_BLOCKED', 'browser-download', cause);
  if (/network|connection|server/.test(message))
    return failure('BROWSER_DOWNLOAD_NETWORK_FAILED', 'browser-download', cause);
  if (/file|disk|path|storage/.test(message))
    return failure('BROWSER_DOWNLOAD_FILE_FAILED', 'browser-download', cause);
  return failure('DOWNLOAD_UNEXPECTED_FAILURE', 'browser-download', cause);
}

export function normalizeFrameFailure(reason: string, cause?: unknown): OperationFailure {
  const codes: Readonly<Record<string, FailureCode>> = {
    'no-duration': 'FRAME_METADATA_UNAVAILABLE',
    timeout: 'FRAME_TIMEOUT',
    'no-frame': 'FRAME_NO_DECODABLE_FRAME',
    'no-canvas': 'FRAME_CANVAS_UNAVAILABLE',
    'no-blob': 'FRAME_IMAGE_ENCODING_FAILED',
  };
  const code = codes[reason] ?? 'FRAME_UNEXPECTED_FAILURE';
  return failure(code, reason === 'no-duration' ? 'frame-metadata' : 'frame-export', cause);
}
