import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { Effect, Layer } from 'effect';
import {
  type DownloadOperation,
  type DownloadOperationResult,
  type OperationBatchOutcome,
} from './contracts.ts';
import {
  attemptReducer,
  failedOperations,
  pendingOperations,
  prepareOriginalFallback,
  prepareRefetchedRetry,
  prepareReencodeRetry,
  prepareRetry,
  summarizeAttempt,
  type AttemptOperation,
  type DownloadAttempt,
  type RefetchedMedia,
} from './attempt.ts';
import { type OperationFailure } from '../errors/contracts.ts';
import { executeExportPlan, ExportEvents, ExportExecution, ExportPlan } from './coordinator.ts';

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
      const execution = Layer.succeed(ExportExecution, {
        frame: executeFrame,
        direct: executeDirect,
        ...(executeSilent ? { silent: executeSilent } : {}),
      });
      const events = Layer.succeed(ExportEvents, {
        progress: (requestId, phase, progress) => {
          commit(
            attemptReducer(attemptRef.current, {
              type: 'progress',
              requestId,
              phase,
              progress,
            })
          );
        },
        settle,
      });
      await Effect.runPromise(
        executeExportPlan(ExportPlan.make({ operations }), approvedReencodes.current).pipe(
          Effect.provide(Layer.merge(execution, events))
        )
      );
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
    const next = prepareRetry(attemptRef.current);
    if (next === attemptRef.current) return;
    commit(next);
    await submit(pendingOperations(next));
  }, [commit, submit]);

  const retryWithFreshMedia = useCallback(
    async (media: readonly RefetchedMedia[]) => {
      const next = prepareRefetchedRetry(attemptRef.current, media);
      if (next === attemptRef.current || !next) return;
      commit(next);
      const pending = pendingOperations(next);
      if (pending.length > 0) await submit(pending);
      else onSettled?.(next);
    },
    [commit, onSettled, submit]
  );

  const downloadOriginals = useCallback(async () => {
    const next = prepareOriginalFallback(attemptRef.current);
    if (next === attemptRef.current) return;
    commit(next);
    await submit(pendingOperations(next));
  }, [commit, submit]);

  const tryReencode = useCallback(async () => {
    const prepared = prepareReencodeRetry(attemptRef.current);
    const operationIds = prepared.operationIds;
    if (operationIds.size === 0) return;
    for (const operationId of operationIds) approvedReencodes.current.add(operationId);
    const next = prepared.attempt;
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
    retryWithFreshMedia,
    downloadOriginals,
    tryReencode,
    clear,
    retryable: failedOperations(attempt),
    pending: pendingOperations(attempt),
  };
}
