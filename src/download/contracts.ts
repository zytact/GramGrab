import { Effect, Schema } from 'effect';

export const RequestIdSchema = Schema.UUID.pipe(Schema.brand('RequestId'));
export type RequestId = Schema.Schema.Type<typeof RequestIdSchema>;

export class DownloadOperation extends Schema.Class<DownloadOperation>('DownloadOperation')({
  requestId: RequestIdSchema,
  itemIndex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  mediaId: Schema.optional(Schema.String),
  url: Schema.String.pipe(Schema.nonEmptyString()),
  filename: Schema.String.pipe(Schema.nonEmptyString()),
  mediaType: Schema.Literal('image', 'video'),
}) {}

export class DownloadMediaRequest extends Schema.Class<DownloadMediaRequest>(
  'DownloadMediaRequest'
)({
  sourceUrl: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
  operations: Schema.Array(DownloadOperation),
}) {}

export class DownloadAcceptedResult extends Schema.Class<DownloadAcceptedResult>(
  'DownloadAcceptedResult'
)({
  requestId: RequestIdSchema,
  status: Schema.Literal('accepted'),
  warning: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
}) {}

export class DownloadFailedResult extends Schema.Class<DownloadFailedResult>(
  'DownloadFailedResult'
)({
  requestId: RequestIdSchema,
  status: Schema.Literal('failed'),
  reason: Schema.String.pipe(Schema.nonEmptyString()),
}) {}

export class DownloadSkippedResult extends Schema.Class<DownloadSkippedResult>(
  'DownloadSkippedResult'
)({
  requestId: RequestIdSchema,
  status: Schema.Literal('skipped'),
  reason: Schema.String.pipe(Schema.nonEmptyString()),
}) {}

const DownloadOperationResult = Schema.Union(
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadSkippedResult
);
export type DownloadOperationResult = Schema.Schema.Type<typeof DownloadOperationResult>;

export class DownloadMediaResponse extends Schema.Class<DownloadMediaResponse>(
  'DownloadMediaResponse'
)({
  results: Schema.Array(DownloadOperationResult),
  error: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
}) {}

export function createRequestId(): RequestId {
  return requestIdFrom(crypto.randomUUID());
}

export function requestIdFrom(value: string): RequestId {
  return Schema.decodeUnknownSync(RequestIdSchema)(value);
}

export async function decodeDownloadMediaRequest(value: unknown): Promise<DownloadMediaRequest> {
  return Effect.runPromise(Schema.decodeUnknown(DownloadMediaRequest)(value));
}

export async function decodeDownloadMediaResponse(value: unknown): Promise<DownloadMediaResponse> {
  return Effect.runPromise(Schema.decodeUnknown(DownloadMediaResponse)(value));
}

export function validateCorrelatedResults(
  operations: readonly DownloadOperation[],
  response: DownloadMediaResponse
):
  | { readonly ok: true; readonly results: readonly DownloadOperationResult[] }
  | { readonly ok: false } {
  if (response.error) return { ok: true, results: failedResults(operations, response.error) };
  if (response.results.length !== operations.length) return { ok: false };

  const expected = new Set(operations.map(operation => operation.requestId));
  const received = new Set<string>();
  for (const result of response.results) {
    if (!expected.has(result.requestId) || received.has(result.requestId)) return { ok: false };
    received.add(result.requestId);
  }
  return received.size === expected.size ? { ok: true, results: response.results } : { ok: false };
}

export function failedResults(
  operations: readonly DownloadOperation[],
  reason: string
): readonly DownloadOperationResult[] {
  return operations.map(operation =>
    DownloadFailedResult.make({ requestId: operation.requestId, status: 'failed', reason })
  );
}
