import { Context, Effect, Schema } from 'effect';
import { runFrameExportBatch } from '../frame-export/batch.ts';
import { clampFrameSecond, frameFilename } from '../frame-export/timestamp.ts';
import { OperationFailure, diagnosticCause } from '../errors/contracts.ts';
import {
  decodeDownloadMediaResponse,
  DownloadFailedResult,
  failedResults,
  validateCorrelatedResults,
  type DownloadOperation,
  type DownloadOperationResult,
  type OperationBatchOutcome,
  createOperationId,
  createRequestId,
} from './contracts.ts';
import { AttemptOperationSchema, type AttemptOperation } from './attempt.ts';

export class ExportPlan extends Schema.Class<ExportPlan>('ExportPlan')({
  operations: Schema.Array(AttemptOperationSchema).pipe(Schema.minItems(1)),
}) {}

export class ExportCandidate extends Schema.Class<ExportCandidate>('ExportCandidate')({
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  itemIndex: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  mediaId: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
  type: Schema.Literal('image', 'video'),
  url: Schema.String.pipe(Schema.nonEmptyString()),
  filenameHint: Schema.String.pipe(Schema.nonEmptyString()),
  selected: Schema.Boolean,
  frameEnabled: Schema.Boolean,
  frameTimestampSeconds: Schema.Number.pipe(Schema.nonNegative()),
  frameDurationSeconds: Schema.optional(Schema.Number.pipe(Schema.positive())),
  removeAudio: Schema.Boolean,
}) {}

function selectedMode(candidate: ExportCandidate): AttemptOperation['mode'] {
  if (candidate.type !== 'video') return 'direct';
  if (candidate.removeAudio) return 'silent';
  return candidate.frameEnabled ? 'frame' : 'direct';
}

function selectedTimestamp(
  candidate: ExportCandidate,
  mode: AttemptOperation['mode']
): number | undefined {
  if (mode !== 'frame') return undefined;
  return clampFrameSecond(
    candidate.frameTimestampSeconds,
    candidate.frameDurationSeconds ?? candidate.frameTimestampSeconds + 1
  );
}

function selectedFilename(
  candidate: ExportCandidate,
  mode: AttemptOperation['mode'],
  originalFilename: string,
  timestampSeconds: number | undefined
): string {
  if (mode === 'silent') return `${candidate.filenameHint}_${candidate.index + 1}_silent.mp4`;
  if (mode === 'frame') return frameFilename(candidate.filenameHint, timestampSeconds ?? 0);
  return originalFilename;
}

function planCandidate(candidate: ExportCandidate): AttemptOperation {
  const mode = selectedMode(candidate);
  const timestampSeconds = selectedTimestamp(candidate, mode);
  const originalFilename = `${candidate.filenameHint}_${candidate.index + 1}.${candidate.type === 'video' ? 'mp4' : 'jpg'}`;
  return {
    operationId: createOperationId(),
    requestId: createRequestId(),
    itemIndex: candidate.itemIndex ?? candidate.index,
    ...(candidate.mediaId ? { mediaId: candidate.mediaId } : {}),
    url: candidate.url,
    filename: selectedFilename(candidate, mode, originalFilename, timestampSeconds),
    mediaType: candidate.type,
    originalUrl: candidate.url,
    originalFilename,
    mode,
    displayIndex: candidate.index,
    ...(timestampSeconds === undefined ? {} : { frameTimestampSeconds: timestampSeconds }),
  };
}

export function planExportOperations(
  candidates: readonly ExportCandidate[]
): readonly AttemptOperation[] {
  return candidates.filter(candidate => candidate.selected).map(planCandidate);
}

export class ExportExecution extends Context.Tag('gramgrab/ExportExecution')<
  ExportExecution,
  {
    readonly frame: (operation: AttemptOperation) => Promise<DownloadOperationResult>;
    readonly direct: (operations: readonly DownloadOperation[]) => Promise<unknown>;
    readonly silent?: (
      operations: readonly AttemptOperation[],
      onProgress: (requestId: string, phase: string, progress: number) => void,
      onPreflightComplete: () => void,
      approvedOperationIds: Set<string>
    ) => Promise<OperationBatchOutcome>;
  }
>() {}

export class ExportEvents extends Context.Tag('gramgrab/ExportEvents')<
  ExportEvents,
  {
    readonly progress: (requestId: string, phase: string, progress: number) => void;
    readonly settle: (
      results: readonly DownloadOperationResult[],
      batchFailure?: OperationFailure
    ) => void;
  }
>() {}

const failure = (
  code: OperationFailure['code'],
  phase: OperationFailure['phase'],
  cause?: unknown
) =>
  OperationFailure.make({
    code,
    phase,
    scope: 'item',
    ...(cause === undefined ? {} : { cause: diagnosticCause(cause) }),
  });

function operationResult(
  operation: AttemptOperation,
  result: DownloadOperationResult | undefined,
  fallback: OperationFailure
): DownloadOperationResult {
  return (
    result ??
    DownloadFailedResult.make({
      requestId: operation.requestId,
      operationId: operation.operationId,
      status: 'failed',
      failure: fallback,
    })
  );
}

export const executeExportPlan = Effect.fn('ExportCoordinator.execute')(function* (
  plan: ExportPlan,
  approvedOperationIds: Set<string>
) {
  const execution = yield* ExportExecution;
  const events = yield* ExportEvents;
  const operations = plan.operations;

  yield* Effect.promise(async () => {
    const tasks: Promise<void>[] = [];
    const silent = operations.filter(operation => operation.mode === 'silent');
    if (silent.length > 0 && execution.silent) {
      let completePreflight = () => {};
      const preflight = new Promise<void>(resolve => {
        completePreflight = resolve;
      });
      tasks.push(
        execution
          .silent(silent, events.progress, completePreflight, approvedOperationIds)
          .then(outcome => events.settle(outcome.outcomes, outcome.failure))
          .catch(cause =>
            events.settle(
              failedResults(silent, failure('SILENT_UNEXPECTED_FAILURE', 'silent-worker', cause))
            )
          )
          .finally(completePreflight)
      );
      await preflight;
    }

    const frames = operations.filter(operation => operation.mode === 'frame');
    if (frames.length > 0) {
      tasks.push(
        (async () => {
          const outcomes = new Map<string, DownloadOperationResult>();
          const batch = await runFrameExportBatch(
            frames.map(operation => operation.displayIndex),
            async displayIndex => {
              const operation = frames.find(candidate => candidate.displayIndex === displayIndex);
              if (!operation) return;
              const result = await execution.frame(operation);
              outcomes.set(operation.requestId, result);
              if (result.status === 'failed') throw result.failure;
            }
          );
          events.settle(
            frames.map(operation => {
              const batchResult = batch.find(result => result.index === operation.displayIndex);
              return operationResult(
                operation,
                outcomes.get(operation.requestId),
                batchResult?.failure instanceof OperationFailure
                  ? batchResult.failure
                  : failure('FRAME_UNEXPECTED_FAILURE', 'frame-export', batchResult?.failure)
              );
            })
          );
        })()
      );
    }

    const direct = operations.filter(operation => operation.mode === 'direct');
    if (direct.length > 0) {
      tasks.push(
        (async () => {
          try {
            const response = await decodeDownloadMediaResponse(await execution.direct(direct));
            const correlated = validateCorrelatedResults(direct, response);
            events.settle(
              correlated.ok
                ? correlated.results
                : failedResults(direct, failure('DOWNLOAD_UNEXPECTED_FAILURE', 'browser-download'))
            );
          } catch (cause) {
            events.settle(
              failedResults(
                direct,
                failure('DOWNLOAD_UNEXPECTED_FAILURE', 'browser-download', cause)
              )
            );
          }
        })()
      );
    }
    await Promise.all(tasks);
  });
});
