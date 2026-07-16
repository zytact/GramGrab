import type { DownloadOperation, DownloadOperationResult } from './contracts.ts';

export interface AttemptOperation extends DownloadOperation {
  readonly mode: 'direct' | 'frame' | 'silent';
  readonly displayIndex: number;
  readonly frameTimestampSeconds?: number;
}

export type AttemptOutcome =
  | { readonly status: 'pending'; readonly phase?: string; readonly progress?: number }
  | { readonly status: 'accepted'; readonly warning?: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'skipped'; readonly reason: string };

export interface AttemptEntry {
  readonly operation: AttemptOperation;
  readonly outcome: AttemptOutcome;
}

export interface DownloadAttempt {
  readonly entries: readonly AttemptEntry[];
  readonly retryCount: number;
}

export type AttemptAction =
  | { readonly type: 'fresh'; readonly operations: readonly AttemptOperation[] }
  | { readonly type: 'retry' }
  | { readonly type: 'settle'; readonly results: readonly DownloadOperationResult[] }
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
        })),
        retryCount: 0,
      };
    case 'retry':
      if (!state) return state;
      return {
        ...state,
        retryCount: state.retryCount + 1,
        entries: state.entries.map(entry =>
          entry.outcome.status === 'failed' ? { ...entry, outcome: { status: 'pending' } } : entry
        ),
      };
    case 'settle': {
      if (!state) return state;
      const byRequestId = new Map(action.results.map(result => [result.requestId, result]));
      return {
        ...state,
        entries: state.entries.map(entry => {
          const result = byRequestId.get(entry.operation.requestId);
          if (!result || entry.outcome.status !== 'pending') return entry;
          const outcome =
            result.status === 'accepted'
              ? {
                  status: 'accepted' as const,
                  ...(result.warning ? { warning: result.warning } : {}),
                }
              : result.status === 'skipped'
                ? { status: 'skipped' as const, reason: result.reason }
                : { status: 'failed' as const, reason: result.reason };
          return {
            ...entry,
            outcome,
          };
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
                outcome: {
                  status: 'pending',
                  phase: action.phase,
                  progress: action.progress,
                },
              }
            : entry
        ),
      };
    case 'clear':
      return undefined;
  }
}

export function pendingOperations(
  attempt: DownloadAttempt | undefined
): readonly AttemptOperation[] {
  return (
    attempt?.entries.flatMap(entry =>
      entry.outcome.status === 'pending' ? [entry.operation] : []
    ) ?? []
  );
}

export function failedOperations(
  attempt: DownloadAttempt | undefined
): readonly AttemptOperation[] {
  return (
    attempt?.entries.flatMap(entry =>
      entry.outcome.status === 'failed' ? [entry.operation] : []
    ) ?? []
  );
}

export interface AttemptSummary {
  readonly pending: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly warnings: number;
  readonly skipped: number;
}

export function summarizeAttempt(attempt: DownloadAttempt | undefined): AttemptSummary {
  return (attempt?.entries ?? []).reduce<AttemptSummary>(
    (summary, entry) => ({
      pending: summary.pending + Number(entry.outcome.status === 'pending'),
      succeeded: summary.succeeded + Number(entry.outcome.status === 'accepted'),
      failed: summary.failed + Number(entry.outcome.status === 'failed'),
      skipped: summary.skipped + Number(entry.outcome.status === 'skipped'),
      warnings:
        summary.warnings +
        Number(entry.outcome.status === 'accepted' && Boolean(entry.outcome.warning)),
    }),
    { pending: 0, succeeded: 0, failed: 0, warnings: 0, skipped: 0 }
  );
}
