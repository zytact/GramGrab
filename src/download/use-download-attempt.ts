import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { runFrameExportBatch } from '../frame-export/batch.ts';
import {
  decodeDownloadMediaResponse,
  DownloadFailedResult,
  failedResults,
  validateCorrelatedResults,
  type DownloadOperation,
  type DownloadOperationResult,
  type OperationBatchOutcome,
} from './contracts.ts';
import {
  attemptReducer,
  failedOperations,
  pendingOperations,
  summarizeAttempt,
  type AttemptOperation,
  type DownloadAttempt,
} from './attempt.ts';
import { OperationFailure, diagnosticCause } from '../errors/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';

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

interface UseDownloadAttemptOptions {
  executeFrame: (operation: AttemptOperation) => Promise<DownloadOperationResult>;
  executeDirect: (operations: readonly DownloadOperation[]) => Promise<unknown>;
  executeSilent?: (
    operations: readonly AttemptOperation[],
    onProgress: (requestId: string, phase: string, progress: number) => void,
    onPreflightComplete: () => void,
    approvedRequestIds: Set<string>
  ) => Promise<OperationBatchOutcome>;
  onAccepted?: (operations: readonly AttemptOperation[]) => void;
  onSettled?: (attempt: DownloadAttempt) => void;
}

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

export function useDownloadAttempt({
  executeFrame,
  executeDirect,
  executeSilent,
  onAccepted,
  onSettled,
}: UseDownloadAttemptOptions) {
  const [attempt, setAttempt] = useState<DownloadAttempt>();
  const attemptRef = useRef<DownloadAttempt | undefined>(undefined);
  const summaryRef = useRef<HTMLElement>(null);
  const approvedReencodes = useRef(new Set<string>());

  const commit = useCallback((next: DownloadAttempt | undefined): DownloadAttempt | undefined => {
    attemptRef.current = next;
    setAttempt(next);
    return next;
  }, []);

  const settle = useCallback(
    (results: readonly DownloadOperationResult[], batchFailure?: OperationFailure) => {
      const next = attemptReducer(attemptRef.current, {
        type: 'settle',
        results,
        ...(batchFailure ? { batchFailure } : {}),
      });
      if (!next) return;
      commit(next);
      const acceptedRequestIds = new Set(
        results.flatMap(result => (result.status === 'started' ? [result.requestId] : []))
      );
      const accepted = next.entries.flatMap(entry =>
        acceptedRequestIds.has(entry.operation.requestId) && entry.outcome.status === 'started'
          ? [entry.operation]
          : []
      );
      onAccepted?.(accepted);
      onSettled?.(next);
      if (next.batchFailure || summarizeAttempt(next).failed > 0)
        queueMicrotask(() => summaryRef.current?.focus());
    },
    [commit, onAccepted, onSettled]
  );

  const submit = useCallback(
    async (operations: readonly AttemptOperation[]) => {
      const tasks: Promise<void>[] = [];
      const silent = operations.filter(operation => operation.mode === 'silent');
      if (silent.length > 0 && executeSilent) {
        let completePreflight = () => {};
        const preflight = new Promise<void>(resolve => {
          completePreflight = resolve;
        });
        tasks.push(
          executeSilent(
            silent,
            (requestId, phase, progress) => {
              const next = attemptReducer(attemptRef.current, {
                type: 'progress',
                requestId,
                phase,
                progress,
              });
              commit(next);
            },
            completePreflight,
            approvedReencodes.current
          )
            .then(outcome => settle(outcome.outcomes, outcome.failure))
            .catch(cause =>
              settle(
                failedResults(silent, failure('SILENT_UNEXPECTED_FAILURE', 'silent-worker', cause))
              )
            )
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
                const result = await executeFrame(operation);
                outcomes.set(operation.requestId, result);
                if (result.status === 'failed') throw result.failure;
              }
            );
            settle(
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
              const raw = await executeDirect(direct);
              const response = await decodeDownloadMediaResponse(raw);
              const correlated = validateCorrelatedResults(direct, response);
              settle(
                correlated.ok
                  ? correlated.results
                  : failedResults(
                      direct,
                      failure('DOWNLOAD_UNEXPECTED_FAILURE', 'browser-download')
                    )
              );
            } catch (cause) {
              settle(
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
    },
    [commit, executeDirect, executeFrame, executeSilent, settle]
  );

  const start = useCallback(
    async (operations: readonly AttemptOperation[]) => {
      if (operations.length === 0) return;
      approvedReencodes.current.clear();
      commit(attemptReducer(undefined, { type: 'fresh', operations }));
      await submit(operations);
    },
    [commit, submit]
  );

  const retry = useCallback(async () => {
    const retryable = failedOperations(attemptRef.current);
    if (retryable.length === 0) return;
    const operationIds = new Set(retryable.map(operation => operation.operationId));
    const next = attemptReducer(attemptRef.current, { type: 'retry', operationIds });
    commit(next);
    await submit(pendingOperations(next));
  }, [commit, submit]);

  const downloadOriginals = useCallback(async () => {
    const batchAllowsOriginal = Boolean(
      attemptRef.current?.batchFailure &&
      FAILURE_PRESENTATION[attemptRef.current.batchFailure.code].actions.includes(
        'download-original'
      )
    );
    const operationIds = new Set(
      (attemptRef.current?.entries ?? []).flatMap(entry =>
        (entry.outcome.status === 'failed' &&
          FAILURE_PRESENTATION[entry.outcome.failure.code].actions.includes('download-original')) ||
        (entry.outcome.status === 'not-attempted' && batchAllowsOriginal)
          ? [entry.operation.operationId]
          : []
      )
    );
    if (operationIds.size === 0) return;
    const next = attemptReducer(attemptRef.current, { type: 'fallback-original', operationIds });
    commit(next);
    await submit(pendingOperations(next));
  }, [commit, submit]);

  const tryReencode = useCallback(async () => {
    const operationIds = new Set(
      (attemptRef.current?.entries ?? []).flatMap(entry =>
        entry.outcome.status === 'failed' &&
        FAILURE_PRESENTATION[entry.outcome.failure.code].actions.includes('try-reencode')
          ? [entry.operation.operationId]
          : []
      )
    );
    if (operationIds.size === 0) return;
    for (const operationId of operationIds) approvedReencodes.current.add(operationId);
    const next = attemptReducer(attemptRef.current, { type: 'retry', operationIds });
    commit(next);
    await submit(pendingOperations(next));
  }, [commit, submit]);

  const clear = useCallback(() => commit(undefined), [commit]);
  const summary = useMemo(() => summarizeAttempt(attempt), [attempt]);
  const busy = summary.pending > 0;

  return {
    attempt,
    summary,
    busy,
    summaryRef: summaryRef as RefObject<HTMLElement>,
    start,
    retry,
    downloadOriginals,
    tryReencode,
    clear,
    retryable: failedOperations(attempt),
    pending: pendingOperations(attempt),
  };
}
