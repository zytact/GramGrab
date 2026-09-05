import { Effect, Schema } from 'effect';
import { OperationIdSchema, RequestIdSchema } from '../download/contracts.ts';
import { OperationFailure } from '../errors/contracts.ts';

const SilentPhase = Schema.Literal(
  'inspecting',
  'awaiting-choice',
  'queued',
  'processing',
  'validating',
  'starting'
);

export type SilentPhase = Schema.Schema.Type<typeof SilentPhase>;

export class SilentPreflight extends Schema.Class<SilentPreflight>('SilentPreflight')({
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  audioTrackCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  videoCodec: Schema.String,
  durationSeconds: Schema.Number.pipe(Schema.nonNegative()),
  sourceBitrate: Schema.optional(Schema.Number.pipe(Schema.positive())),
  width: Schema.Number.pipe(Schema.int(), Schema.positive()),
  height: Schema.Number.pipe(Schema.int(), Schema.positive()),
  copyCompatible: Schema.Boolean,
  reason: Schema.optional(Schema.String),
}) {}

export class InspectSilentVideo extends Schema.TaggedClass<InspectSilentVideo>()('inspect', {
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  url: Schema.String.pipe(Schema.nonEmptyString()),
  useCachedInput: Schema.Boolean,
}) {}
export class ProcessSilentVideo extends Schema.TaggedClass<ProcessSilentVideo>()('process', {
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  transcode: Schema.Boolean,
}) {}
export class ReleaseSilentVideo extends Schema.TaggedClass<ReleaseSilentVideo>()('release', {
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
}) {}
const SilentWorkerRequest = Schema.Union(
  InspectSilentVideo,
  ProcessSilentVideo,
  ReleaseSilentVideo
);

export class SilentProgress extends Schema.TaggedClass<SilentProgress>()('progress', {
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  phase: SilentPhase,
  progress: Schema.Number.pipe(Schema.between(0, 1)),
}) {}
export class SilentInspected extends Schema.TaggedClass<SilentInspected>()('inspected', {
  preflight: SilentPreflight,
}) {}
export class SilentProcessed extends Schema.TaggedClass<SilentProcessed>()('processed', {
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
  alreadySilent: Schema.Boolean,
  opfsName: Schema.optional(Schema.String),
}) {}
export class SilentReleased extends Schema.TaggedClass<SilentReleased>()('released', {
  operationId: OperationIdSchema,
  requestId: RequestIdSchema,
}) {}
export class SilentWorkerError extends Schema.TaggedClass<SilentWorkerError>()(
  'SilentWorkerError',
  {
    requestId: RequestIdSchema,
    operationId: OperationIdSchema,
    failure: OperationFailure,
  }
) {}
const SilentWorkerResponse = Schema.Union(
  SilentProgress,
  SilentInspected,
  SilentProcessed,
  SilentReleased,
  SilentWorkerError
);
export type SilentWorkerResponse = Schema.Schema.Type<typeof SilentWorkerResponse>;

export const decodeSilentWorkerRequest = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(SilentWorkerRequest)(value));
export const decodeSilentWorkerResponse = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknown(SilentWorkerResponse)(value));
