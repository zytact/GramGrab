import {
  OperationFailure,
  diagnosticCause,
  type InstagramFailureCode,
  type FailurePhase,
  type WhatsAppFailureCode,
  type WhatsAppExclusiveFailureCode,
  type WhatsAppFailurePhase,
  WhatsAppStructuralEvidence,
} from './contracts.ts';
import type { WhatsAppShapeEvidence } from '../whatsapp/contracts.ts';
import type { WhatsAppCaptureFailureReason } from '../whatsapp/capture.ts';
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
  code: InstagramFailureCode,
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
    return failure('INPUT_INVALID_SOURCE_URL', 'input', cause, 'batch');
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

/**
 * Failures of a direct transfer of an already-resolved media URL: previews, video blobs, and any
 * other read of a signed CDN link. HTTP status carries the whole distinction, exactly as the
 * silent-video input cache classifies it.
 */
export function normalizeMediaTransferFailure(cause: unknown): OperationFailure {
  if (cause instanceof NetworkError)
    return failure('MEDIA_NETWORK_FAILED', 'media-transfer', cause);
  if (cause instanceof HttpError) {
    if (cause.status === 401 || cause.status === 403)
      return failure('MEDIA_URL_EXPIRED', 'media-transfer', cause);
    if (cause.status === 404) return failure('MEDIA_NOT_FOUND', 'media-transfer', cause);
    return failure('MEDIA_NETWORK_FAILED', 'media-transfer', cause);
  }
  return failure('MEDIA_UNEXPECTED_FAILURE', 'media-transfer', cause);
}

/**
 * Failures of GramGrab's own download-history store. The store is shared by every platform and
 * holds names a WhatsApp receipt must never expose, so these failures carry no diagnostic cause.
 */
export function historyFailure(
  code:
    | 'HISTORY_VERSION_UNSUPPORTED'
    | 'HISTORY_ENTRY_NOT_FOUND'
    | 'HISTORY_ITEM_UNRESOLVED'
    | 'HISTORY_STORE_FAILED'
): OperationFailure {
  return OperationFailure.make({
    code,
    phase: 'history',
    scope:
      code === 'HISTORY_VERSION_UNSUPPORTED' || code === 'HISTORY_STORE_FAILED' ? 'batch' : 'item',
  });
}

// downloads.download exposes only runtime.lastError.message in callback-based browsers.
export function normalizeBrowserDownloadFailure(
  cause: unknown,
  platform: 'instagram' | 'whatsapp' = 'instagram'
): OperationFailure {
  const message =
    cause instanceof Error ? cause.message.toLowerCase() : String(cause).toLowerCase();
  const code = /permission|denied|blocked|not allowed/.test(message)
    ? 'BROWSER_DOWNLOAD_BLOCKED'
    : /network|connection|server/.test(message)
      ? 'BROWSER_DOWNLOAD_NETWORK_FAILED'
      : /file|disk|path|storage/.test(message)
        ? 'BROWSER_DOWNLOAD_FILE_FAILED'
        : 'DOWNLOAD_UNEXPECTED_FAILURE';
  return platform === 'whatsapp'
    ? whatsappFailure(code, 'browser-download', 'unknown')
    : failure(code, 'browser-download', cause);
}

function structuralNodeShape(shape: WhatsAppShapeEvidence | undefined) {
  if (shape) {
    return {
      playerCount: shape.playerCount,
      imageCount: shape.imageCount,
      blobImageCount: shape.blobImageCount,
      dataImageCount: shape.dataImageCount,
      videoCount: shape.videoCount,
      markedVideoCount: shape.markedVideoCount,
      overflow: shape.overflow,
    };
  }
  return {
    playerCount: 0,
    imageCount: 0,
    blobImageCount: 0,
    dataImageCount: 0,
    videoCount: 0,
    markedVideoCount: 0,
    overflow: false,
  };
}

function evidence(
  invariant: WhatsAppStructuralEvidence['invariant'],
  shape?: WhatsAppShapeEvidence
): WhatsAppStructuralEvidence {
  return WhatsAppStructuralEvidence.make({
    extractionContractVersion: 1,
    invariant,
    nodeShape: structuralNodeShape(shape),
    mediaKind: 'unknown',
    readiness: 'unknown',
    sourceProtocolClass: 'none',
    dimensionState: 'unknown',
    playerState: shape ? 'single' : 'absent',
    guardState: 'unknown',
    bytesOwned: false,
    discardCompleted: true,
    blobUrlCreated: false,
    blobUrlRevoked: false,
    retentionCeilingArmed: false,
  });
}

function whatsappFailure(
  code: WhatsAppFailureCode,
  phase: WhatsAppFailurePhase,
  invariant: WhatsAppStructuralEvidence['invariant'],
  shape?: WhatsAppShapeEvidence
): OperationFailure {
  return OperationFailure.make({
    code,
    phase,
    scope: 'item',
    platform: 'whatsapp',
    structuralEvidence: evidence(invariant, shape),
  });
}

const whatsappCaptureFailureMappings: Readonly<
  Record<
    WhatsAppCaptureFailureReason,
    Readonly<{
      code: WhatsAppExclusiveFailureCode;
      phase: WhatsAppFailurePhase;
      invariant: WhatsAppStructuralEvidence['invariant'];
    }>
  >
> = {
  'page-access-failed': {
    code: 'WHATSAPP_PAGE_ACCESS_FAILED',
    phase: 'whatsapp-page-access',
    invariant: 'page-access',
  },
  'not-visible': {
    code: 'WHATSAPP_STATUS_NOT_VISIBLE',
    phase: 'whatsapp-extraction',
    invariant: 'no-active-player',
  },
  unsupported: {
    code: 'WHATSAPP_STATUS_UNSUPPORTED',
    phase: 'whatsapp-extraction',
    invariant: 'unsupported-media',
  },
  'not-ready': {
    code: 'WHATSAPP_STATUS_NOT_READY',
    phase: 'whatsapp-extraction',
    invariant: 'media-readiness',
  },
  'status-changed': {
    code: 'WHATSAPP_STATUS_CHANGED',
    phase: 'whatsapp-extraction',
    invariant: 'guard-changed',
  },
  'format-changed': {
    code: 'WHATSAPP_FORMAT_CHANGED',
    phase: 'whatsapp-extraction',
    invariant: 'player-marker',
  },
  'transfer-failed': {
    code: 'WHATSAPP_ACQUISITION_FAILED',
    phase: 'whatsapp-extraction',
    invariant: 'protocol',
  },
  cancelled: {
    code: 'WHATSAPP_ACQUISITION_FAILED',
    phase: 'whatsapp-extraction',
    invariant: 'protocol',
  },
  'download-failed': {
    code: 'WHATSAPP_ACQUISITION_FAILED',
    phase: 'whatsapp-extraction',
    invariant: 'unknown',
  },
  'retention-expired': {
    code: 'WHATSAPP_ACQUISITION_FAILED',
    phase: 'whatsapp-extraction',
    invariant: 'retention-expired',
  },
};

export function normalizeWhatsAppCaptureFailure(
  reason: WhatsAppCaptureFailureReason,
  shape?: WhatsAppShapeEvidence
): OperationFailure {
  const mapping = whatsappCaptureFailureMappings[reason];
  return whatsappFailure(mapping.code, mapping.phase, mapping.invariant, shape);
}

export function normalizeWhatsAppSilentFailure(
  code:
    | 'SILENT_MEMORY_CAPACITY_EXCEEDED'
    | 'SILENT_SOURCE_NO_VIDEO'
    | 'SILENT_SOURCE_CONVERSION_UNSUPPORTED'
    | 'SILENT_REENCODE_FAILED',
  phase: 'silent-inspection' | 'silent-reencode'
): OperationFailure {
  return whatsappFailure(code, phase, 'unknown');
}

export function normalizeFrameFailure(reason: string, cause?: unknown): OperationFailure {
  const codes: Readonly<Record<string, InstagramFailureCode>> = {
    'no-duration': 'FRAME_METADATA_UNAVAILABLE',
    timeout: 'FRAME_TIMEOUT',
    'no-frame': 'FRAME_NO_DECODABLE_FRAME',
    'no-canvas': 'FRAME_CANVAS_UNAVAILABLE',
    'no-blob': 'FRAME_IMAGE_ENCODING_FAILED',
  };
  const code = codes[reason] ?? 'FRAME_UNEXPECTED_FAILURE';
  return failure(code, reason === 'no-duration' ? 'frame-metadata' : 'frame-export', cause);
}
