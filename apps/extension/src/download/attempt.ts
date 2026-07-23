import { createRequestId, DownloadOperation, type DownloadOperationResult } from './contracts.ts';
import { Schema } from 'effect';
import type { OperationFailure, OperationWarning, SkipCode } from '../errors/contracts.ts';
import { FAILURE_PRESENTATION, retryable } from '../errors/presentation.ts';

export const AttemptOperationSchema = Schema.Struct({
  ...DownloadOperation.fields,
  mode: Schema.Literal('direct', 'frame', 'silent'),
  displayIndex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  frameTimestampSeconds: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
});
export type AttemptOperation = Schema.Schema.Type<typeof AttemptOperationSchema>;

export type AttemptOutcome =
  | { readonly status: 'pending'; readonly phase?: string; readonly progress?: number }
  | { readonly status: 'started'; readonly warning?: OperationWarning }
  | { readonly status: 'failed'; readonly failure: OperationFailure }
  | { readonly status: 'skipped'; readonly code: SkipCode }
  | { readonly status: 'not-attempted' };

export interface AttemptEntry {
  readonly operation: AttemptOperation;
  readonly outcome: AttemptOutcome;
  readonly executionCount: number;
  readonly manualRetryCount: number;
}
export interface DownloadAttempt {
  readonly entries: readonly AttemptEntry[];
  readonly batchFailure?: OperationFailure;
}

export type AttemptAction =
  | { readonly type: 'fresh'; readonly operations: readonly AttemptOperation[] }
  | { readonly type: 'retry'; readonly operationIds?: ReadonlySet<string> }
  | { readonly type: 'fallback-original'; readonly operationIds: ReadonlySet<string> }
  | {
      readonly type: 'settle';
      readonly results: readonly DownloadOperationResult[];
      readonly batchFailure?: OperationFailure;
    }
  | {
      readonly type: 'progress';
      readonly requestId: string;
      readonly phase: string;
      readonly progress: number;
    }
  | { readonly type: 'clear' };

export function attemptReducer(
  state: DownloadAttempt | undefined,
  action: AttemptAction
): DownloadAttempt | undefined {
  switch (action.type) {
    case 'fresh':
      return {
        entries: action.operations.map(operation => ({
          operation,
          outcome: { status: 'pending' },
          executionCount: 1,
          manualRetryCount: 0,
        })),
      };
    case 'retry':
      if (!state) return state;
      return {
        ...state,
        batchFailure: undefined,
        entries: state.entries.map(entry => {
          const selected =
            !action.operationIds || action.operationIds.has(entry.operation.operationId);
          if (entry.outcome.status !== 'failed' || !selected) return entry;
          return {
            ...entry,
            operation: { ...entry.operation, requestId: createRequestId() },
            outcome: { status: 'pending' },
            executionCount: entry.executionCount + 1,
            manualRetryCount: entry.manualRetryCount + 1,
          };
        }),
      };
    case 'fallback-original':
      if (!state) return state;
      return {
        ...state,
        entries: state.entries.map(entry => {
          if (
            !['failed', 'not-attempted'].includes(entry.outcome.status) ||
            !action.operationIds.has(entry.operation.operationId)
          )
            return entry;
          return {
            ...entry,
            operation: {
              ...entry.operation,
              requestId: createRequestId(),
              url: entry.operation.originalUrl,
              filename: entry.operation.originalFilename,
              mode: 'direct',
            },
            outcome: { status: 'pending' },
            executionCount: entry.executionCount + 1,
          };
        }),
      };
    case 'settle': {
      if (!state) return state;
      const byOperationId = new Map(action.results.map(result => [result.operationId, result]));
      return {
        ...state,
        ...(action.batchFailure ? { batchFailure: action.batchFailure } : {}),
        entries: state.entries.map(entry => {
          const result = byOperationId.get(entry.operation.operationId);
          if (
            !result ||
            result.requestId !== entry.operation.requestId ||
            entry.outcome.status !== 'pending'
          )
            return entry;
          const outcome: AttemptOutcome =
            result.status === 'started'
              ? { status: 'started', ...(result.warning ? { warning: result.warning } : {}) }
              : result.status === 'failed'
                ? { status: 'failed', failure: result.failure }
                : result.status === 'skipped'
                  ? { status: 'skipped', code: result.code }
                  : { status: 'not-attempted' };
          return { ...entry, outcome };
        }),
      };
    }
    case 'progress':
      if (!state) return state;
      return {
        ...state,
        entries: state.entries.map(entry =>
          entry.operation.requestId === action.requestId && entry.outcome.status === 'pending'
            ? {
                ...entry,
                outcome: { status: 'pending', phase: action.phase, progress: action.progress },
              }
            : entry
        ),
      };
    case 'clear':
      return undefined;
  }
}

export const pendingOperations = (
  attempt: DownloadAttempt | undefined
): readonly AttemptOperation[] =>
  attempt?.entries.flatMap(entry =>
    entry.outcome.status === 'pending' ? [entry.operation] : []
  ) ?? [];
export const failedOperations = (
  attempt: DownloadAttempt | undefined
): readonly AttemptOperation[] =>
  attempt?.entries.flatMap(entry =>
    entry.outcome.status === 'failed' &&
    FAILURE_PRESENTATION[entry.outcome.failure.code].actions.includes('retry-operation') &&
    retryable(entry.outcome.failure.code, entry.manualRetryCount)
      ? [entry.operation]
      : []
  ) ?? [];

export function prepareRetry(attempt: DownloadAttempt | undefined): DownloadAttempt | undefined {
  const operationIds = new Set(failedOperations(attempt).map(operation => operation.operationId));
  return operationIds.size === 0
    ? attempt
    : attemptReducer(attempt, { type: 'retry', operationIds });
}

export function prepareOriginalFallback(
  attempt: DownloadAttempt | undefined
): DownloadAttempt | undefined {
  const batchAllowsOriginal = Boolean(
    attempt?.batchFailure &&
    FAILURE_PRESENTATION[attempt.batchFailure.code].actions.includes('download-original')
  );
  const operationIds = new Set(
    (attempt?.entries ?? []).flatMap(entry =>
      (entry.outcome.status === 'failed' &&
        FAILURE_PRESENTATION[entry.outcome.failure.code].actions.includes('download-original')) ||
      (entry.outcome.status === 'not-attempted' && batchAllowsOriginal)
        ? [entry.operation.operationId]
        : []
    )
  );
  return operationIds.size === 0
    ? attempt
    : attemptReducer(attempt, { type: 'fallback-original', operationIds });
}

export function prepareReencodeRetry(attempt: DownloadAttempt | undefined): {
  readonly attempt: DownloadAttempt | undefined;
  readonly operationIds: ReadonlySet<string>;
} {
  const operationIds = new Set(
    (attempt?.entries ?? []).flatMap(entry =>
      entry.outcome.status === 'failed' &&
      FAILURE_PRESENTATION[entry.outcome.failure.code].actions.includes('try-reencode')
        ? [entry.operation.operationId]
        : []
    )
  );
  return {
    operationIds,
    attempt:
      operationIds.size === 0 ? attempt : attemptReducer(attempt, { type: 'retry', operationIds }),
  };
}

export interface AttemptSummary {
  readonly pending: number;
  readonly started: number;
  readonly failed: number;
  readonly warnings: number;
  readonly skipped: number;
  readonly notAttempted: number;
}
export function summarizeAttempt(attempt: DownloadAttempt | undefined): AttemptSummary {
  return (attempt?.entries ?? []).reduce<AttemptSummary>(
    (summary, entry) => ({
      pending: summary.pending + Number(entry.outcome.status === 'pending'),
      started: summary.started + Number(entry.outcome.status === 'started'),
      failed: summary.failed + Number(entry.outcome.status === 'failed'),
      skipped: summary.skipped + Number(entry.outcome.status === 'skipped'),
      notAttempted: summary.notAttempted + Number(entry.outcome.status === 'not-attempted'),
      warnings:
        summary.warnings +
        Number(entry.outcome.status === 'started' && Boolean(entry.outcome.warning)),
    }),
    { pending: 0, started: 0, failed: 0, warnings: 0, skipped: 0, notAttempted: 0 }
  );
}
