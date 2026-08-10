import { Effect, Schema } from 'effect';
import { FAILURE_CODES, FailureCodeSchema, type FailureCode } from '@gramgrab/protocol';

export { FAILURE_CODES, FailureCodeSchema, type FailureCode };

export const FailurePhaseSchema = Schema.Literal(
  'input',
  'source',
  'media-transfer',
  'browser-download',
  'frame-metadata',
  'frame-export',
  'silent-storage',
  'silent-inspection',
  'silent-copy',
  'silent-reencode',
  'silent-validation',
  'silent-worker',
  'whatsapp-page-access',
  'whatsapp-extraction'
);
export type FailurePhase = Schema.Schema.Type<typeof FailurePhaseSchema>;

const RecoveryActionSchema = Schema.Literal(
  'retry-operation',
  'refetch-source',
  'open-in-instagram',
  'download-original',
  'try-reencode',
  'copy-diagnostics',
  'reload-workspace'
);
export type RecoveryAction = Schema.Schema.Type<typeof RecoveryActionSchema>;

export const WarningCodeSchema = Schema.Literal(
  'HISTORY_SAVE_FAILED',
  'SILENT_TEMPORARY_FILE_CLEANUP_UNCONFIRMED'
);
export type WarningCode = Schema.Schema.Type<typeof WarningCodeSchema>;

export const SkipCodeSchema = Schema.Literal('SILENT_REENCODE_DECLINED');
export type SkipCode = Schema.Schema.Type<typeof SkipCodeSchema>;

class DiagnosticCause extends Schema.Class<DiagnosticCause>('DiagnosticCause')({
  name: Schema.optional(Schema.String),
  message: Schema.String,
  stack: Schema.optional(Schema.String),
}) {}

const StructuralCount = Schema.Number.pipe(Schema.int(), Schema.between(0, 8));

export class WhatsAppStructuralEvidence extends Schema.Class<WhatsAppStructuralEvidence>(
  'WhatsAppStructuralEvidence'
)({
  extractionContractVersion: Schema.Literal(1),
  invariant: Schema.Literal(
    'page-access',
    'no-active-player',
    'unsupported-media',
    'media-readiness',
    'guard-changed',
    'player-marker',
    'protocol',
    'unknown'
  ),
  nodeShape: Schema.Struct({
    playerCount: StructuralCount,
    imageCount: StructuralCount,
    blobImageCount: StructuralCount,
    dataImageCount: StructuralCount,
    videoCount: StructuralCount,
    markedVideoCount: StructuralCount,
    overflow: Schema.Boolean,
  }),
  mediaKind: Schema.Literal('none', 'photo', 'video', 'unknown'),
  readiness: Schema.Literal('unknown', 'ready', 'loading'),
  sourceProtocolClass: Schema.Literal('none', 'blob', 'data', 'other'),
  dimensionState: Schema.Literal('unknown', 'valid', 'loading', 'out-of-range'),
  playerState: Schema.Literal('absent', 'single', 'multiple', 'player-like-unmarked'),
  guardState: Schema.Literal('unknown', 'intact', 'changed', 'absent'),
  bytesOwned: Schema.Boolean,
  discardCompleted: Schema.Boolean,
  blobUrlCreated: Schema.Boolean,
  blobUrlRevoked: Schema.Boolean,
  retentionCeilingArmed: Schema.Boolean,
}) {}

const InstagramFailureCodeSchema = Schema.Literal(
  'INPUT_INVALID_SOURCE_URL',
  'SOURCE_USERNAME_UNRESOLVED',
  'SOURCE_MEDIA_NOT_FOUND',
  'IG_NOT_AUTHENTICATED',
  'IG_ACCESS_FORBIDDEN',
  'IG_RATE_LIMITED',
  'IG_RESPONSE_SHAPE_UNKNOWN',
  'IG_REQUEST_REJECTED',
  'SOURCE_NETWORK_FAILED',
  'SOURCE_SERVER_FAILED',
  'SOURCE_UNEXPECTED_FAILURE',
  'MEDIA_URL_EXPIRED',
  'MEDIA_NOT_FOUND',
  'MEDIA_DASH_ONLY_UNSUPPORTED',
  'INSTANT_NOT_ACTIVE',
  'MEDIA_NETWORK_FAILED',
  'MEDIA_RESPONSE_EMPTY',
  'BROWSER_DOWNLOAD_BLOCKED',
  'BROWSER_DOWNLOAD_NETWORK_FAILED',
  'BROWSER_DOWNLOAD_FILE_FAILED',
  'DOWNLOAD_UNEXPECTED_FAILURE',
  'FRAME_METADATA_UNAVAILABLE',
  'FRAME_TIMEOUT',
  'FRAME_NO_DECODABLE_FRAME',
  'FRAME_CANVAS_UNAVAILABLE',
  'FRAME_IMAGE_ENCODING_FAILED',
  'FRAME_UNEXPECTED_FAILURE',
  'SILENT_STORAGE_UNAVAILABLE',
  'SILENT_STORAGE_CAPACITY_EXCEEDED',
  'SILENT_STORAGE_READ_FAILED',
  'SILENT_STORAGE_WRITE_FAILED',
  'SILENT_SOURCE_NO_VIDEO',
  'SILENT_INPUT_INSPECTION_FAILED',
  'SILENT_COPY_FAILED',
  'SILENT_H264_ENCODER_UNAVAILABLE',
  'SILENT_SOURCE_CONVERSION_UNSUPPORTED',
  'SILENT_REENCODE_FAILED',
  'SILENT_UNEXPECTED_FAILURE',
  'SILENT_OUTPUT_NO_VIDEO',
  'SILENT_OUTPUT_HAS_AUDIO',
  'SILENT_WORKER_UNAVAILABLE',
  'SILENT_WORKER_PROTOCOL_FAILURE'
);
export type InstagramFailureCode = Schema.Schema.Type<typeof InstagramFailureCodeSchema>;

const WhatsAppExclusiveFailureCodeSchema = Schema.Literal(
  'WHATSAPP_PAGE_ACCESS_FAILED',
  'WHATSAPP_STATUS_NOT_VISIBLE',
  'WHATSAPP_STATUS_UNSUPPORTED',
  'WHATSAPP_STATUS_NOT_READY',
  'WHATSAPP_STATUS_CHANGED',
  'WHATSAPP_FORMAT_CHANGED',
  'WHATSAPP_ACQUISITION_FAILED'
);
export type WhatsAppExclusiveFailureCode = Schema.Schema.Type<
  typeof WhatsAppExclusiveFailureCodeSchema
>;

const WhatsAppCommonFailureCodeSchema = Schema.Literal(
  'BROWSER_DOWNLOAD_BLOCKED',
  'BROWSER_DOWNLOAD_NETWORK_FAILED',
  'BROWSER_DOWNLOAD_FILE_FAILED',
  'DOWNLOAD_UNEXPECTED_FAILURE'
);
export type WhatsAppCommonFailureCode = Schema.Schema.Type<typeof WhatsAppCommonFailureCodeSchema>;

const WhatsAppFailureCodeSchema = Schema.Union(
  WhatsAppExclusiveFailureCodeSchema,
  WhatsAppCommonFailureCodeSchema
);
export type WhatsAppFailureCode = Schema.Schema.Type<typeof WhatsAppFailureCodeSchema>;

const WhatsAppFailurePhaseSchema = Schema.Literal(
  'browser-download',
  'whatsapp-page-access',
  'whatsapp-extraction'
);
export type WhatsAppFailurePhase = Schema.Schema.Type<typeof WhatsAppFailurePhaseSchema>;

class InstagramOperationFailure extends Schema.Class<InstagramOperationFailure>(
  'InstagramOperationFailure'
)({
  platform: Schema.Literal('instagram'),
  code: InstagramFailureCodeSchema,
  phase: FailurePhaseSchema,
  scope: Schema.Literal('batch', 'item'),
  cause: Schema.optional(DiagnosticCause),
}) {}

class WhatsAppOperationFailure extends Schema.Class<WhatsAppOperationFailure>(
  'WhatsAppOperationFailure'
)({
  platform: Schema.Literal('whatsapp'),
  code: WhatsAppFailureCodeSchema,
  phase: WhatsAppFailurePhaseSchema,
  scope: Schema.Literal('item'),
  structuralEvidence: WhatsAppStructuralEvidence,
}) {}

const LegacyInstagramOperationFailure = Schema.Struct({
  code: InstagramFailureCodeSchema,
  phase: FailurePhaseSchema,
  scope: Schema.Literal('batch', 'item'),
  cause: Schema.optional(DiagnosticCause),
});

const DecodedLegacyInstagramOperationFailure = Schema.transform(
  LegacyInstagramOperationFailure,
  InstagramOperationFailure,
  {
    strict: true,
    decode: failure => InstagramOperationFailure.make({ ...failure, platform: 'instagram' }),
    encode: failure => ({
      code: failure.code,
      phase: failure.phase,
      scope: failure.scope,
      ...(failure.cause ? { cause: failure.cause } : {}),
    }),
  }
);

const OperationFailureSchema = Schema.Union(
  InstagramOperationFailure,
  DecodedLegacyInstagramOperationFailure,
  WhatsAppOperationFailure
);
export type OperationFailure = Schema.Schema.Type<typeof OperationFailureSchema>;

type InstagramOperationFailureInput = {
  readonly code: InstagramFailureCode;
  readonly phase: FailurePhase;
  readonly scope: 'batch' | 'item';
  readonly cause?: DiagnosticCause;
};

type WhatsAppOperationFailureInput = {
  readonly platform: 'whatsapp';
  readonly code: WhatsAppFailureCode;
  readonly phase: WhatsAppFailurePhase;
  readonly scope: 'item';
  readonly structuralEvidence: WhatsAppStructuralEvidence;
};

function makeOperationFailure(input: InstagramOperationFailureInput): InstagramOperationFailure;
function makeOperationFailure(input: WhatsAppOperationFailureInput): WhatsAppOperationFailure;
function makeOperationFailure(
  input: InstagramOperationFailureInput | WhatsAppOperationFailureInput
): OperationFailure {
  if ('platform' in input) return WhatsAppOperationFailure.make(input);
  return InstagramOperationFailure.make({ ...input, platform: 'instagram' });
}

export const OperationFailure = Object.assign(OperationFailureSchema, {
  make: makeOperationFailure,
});
export const isOperationFailure = Schema.is(OperationFailureSchema);

export class OperationWarning extends Schema.Class<OperationWarning>('OperationWarning')({
  code: WarningCodeSchema,
  cause: Schema.optional(DiagnosticCause),
}) {}

export function diagnosticCause(cause: unknown): DiagnosticCause {
  if (cause instanceof Error)
    return DiagnosticCause.make({
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    });
  return DiagnosticCause.make({ message: String(cause) });
}

export function isWhatsAppCommonFailureCode(
  code: WhatsAppFailureCode
): code is WhatsAppCommonFailureCode {
  return Schema.is(WhatsAppCommonFailureCodeSchema)(code);
}

export const decodeOperationFailure = (value: unknown) =>
  Effect.runPromise(
    Schema.decodeUnknown(OperationFailureSchema, { onExcessProperty: 'error' })(value)
  );
