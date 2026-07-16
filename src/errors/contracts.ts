import { Effect, Schema } from 'effect';

export const FAILURE_CODES = [
  'INPUT_INVALID_INSTAGRAM_URL',
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
  'SILENT_WORKER_PROTOCOL_FAILURE',
] as const;

const FailureCodeSchema = Schema.Literal(...FAILURE_CODES);
export type FailureCode = Schema.Schema.Type<typeof FailureCodeSchema>;

const FailurePhaseSchema = Schema.Literal(
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
  'silent-worker'
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

const WarningCodeSchema = Schema.Literal(
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

export class OperationFailure extends Schema.Class<OperationFailure>('OperationFailure')({
  code: FailureCodeSchema,
  phase: FailurePhaseSchema,
  scope: Schema.Literal('batch', 'item'),
  cause: Schema.optional(DiagnosticCause),
}) {}

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

export const decodeOperationFailure = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(OperationFailure)(value));
