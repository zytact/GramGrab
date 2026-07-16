import { Effect, Schema } from 'effect';
import { OperationFailure, OperationWarning, SkipCodeSchema } from '../errors/contracts.ts';

export const OperationIdSchema = Schema.UUID.pipe(Schema.brand('OperationId'));
export type OperationId = Schema.Schema.Type<typeof OperationIdSchema>;
export const RequestIdSchema = Schema.UUID.pipe(Schema.brand('RequestId'));
export type RequestId = Schema.Schema.Type<typeof RequestIdSchema>;

export class DownloadOperation extends Schema.Class<DownloadOperation>('DownloadOperation')({
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  itemIndex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  mediaId: Schema.optional(Schema.String),
  url: Schema.String.pipe(Schema.nonEmptyString()),
  filename: Schema.String.pipe(Schema.nonEmptyString()),
  originalUrl: Schema.String.pipe(Schema.nonEmptyString()),
  originalFilename: Schema.String.pipe(Schema.nonEmptyString()),
  mediaType: Schema.Literal('image', 'video'),
}) {}

export class DownloadMediaRequest extends Schema.Class<DownloadMediaRequest>(
  'DownloadMediaRequest'
)({
  sourceUrl: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
  operations: Schema.Array(DownloadOperation),
}) {}

export class DownloadStartedResult extends Schema.Class<DownloadStartedResult>(
  'DownloadStartedResult'
)({
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  status: Schema.Literal('started'),
  warning: Schema.optional(OperationWarning),
}) {}

export class DownloadFailedResult extends Schema.Class<DownloadFailedResult>(
  'DownloadFailedResult'
)({
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  status: Schema.Literal('failed'),
  failure: OperationFailure,
}) {}

export class DownloadSkippedResult extends Schema.Class<DownloadSkippedResult>(
  'DownloadSkippedResult'
)({
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  status: Schema.Literal('skipped'),
  code: SkipCodeSchema,
}) {}

export class DownloadNotAttemptedResult extends Schema.Class<DownloadNotAttemptedResult>(
  'DownloadNotAttemptedResult'
)({
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  status: Schema.Literal('not-attempted'),
}) {}

export const DownloadAcceptedResult = DownloadStartedResult;
const DownloadOperationResult = Schema.Union(
  DownloadStartedResult,
  DownloadFailedResult,
  DownloadSkippedResult,
  DownloadNotAttemptedResult
);
export type DownloadOperationResult = Schema.Schema.Type<typeof DownloadOperationResult>;

export class DownloadMediaResponse extends Schema.Class<DownloadMediaResponse>(
  'DownloadMediaResponse'
)({
  results: Schema.Array(DownloadOperationResult),
  failure: Schema.optional(OperationFailure),
}) {}

export class OperationBatchOutcome extends Schema.Class<OperationBatchOutcome>(
  'OperationBatchOutcome'
)({
  outcomes: Schema.Array(DownloadOperationResult),
  failure: Schema.optional(OperationFailure),
}) {}

export const createOperationId = (): OperationId => operationIdFrom(crypto.randomUUID());
export const createRequestId = (): RequestId => requestIdFrom(crypto.randomUUID());
export const operationIdFrom = (value: string): OperationId =>
  Schema.decodeUnknownSync(OperationIdSchema)(value);
export const requestIdFrom = (value: string): RequestId =>
  Schema.decodeUnknownSync(RequestIdSchema)(value);

export const decodeDownloadMediaRequest = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(DownloadMediaRequest)(value));
export const decodeDownloadMediaResponse = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(DownloadMediaResponse)(value));

export function validateCorrelatedResults(
  operations: readonly DownloadOperation[],
  response: DownloadMediaResponse
):
  | { readonly ok: true; readonly results: readonly DownloadOperationResult[] }
  | { readonly ok: false } {
  if (response.failure) return { ok: true, results: failedResults(operations, response.failure) };
  if (response.results.length !== operations.length) return { ok: false };
  const expected = new Map(
    operations.map(operation => [operation.requestId, operation.operationId])
  );
  const received = new Set<string>();
  for (const result of response.results) {
    if (expected.get(result.requestId) !== result.operationId || received.has(result.requestId))
      return { ok: false };
    received.add(result.requestId);
  }
  return { ok: true, results: response.results };
}

export function failedResults(
  operations: readonly DownloadOperation[],
  failure: OperationFailure
): readonly DownloadOperationResult[] {
  return operations.map(operation =>
    DownloadFailedResult.make({
      operationId: operation.operationId,
      requestId: operation.requestId,
      status: 'failed',
      failure,
    })
  );
}
