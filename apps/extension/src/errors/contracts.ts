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
