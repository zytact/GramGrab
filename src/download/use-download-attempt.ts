import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { runFrameExportBatch } from '../frame-export/batch.ts';
import {
  decodeDownloadMediaResponse,
  DownloadFailedResult,
  failedResults,
  validateCorrelatedResults,
  type DownloadOperation,
  type DownloadOperationResult,
} from './contracts.ts';
import {
  attemptReducer,
  failedOperations,
  pendingOperations,
  summarizeAttempt,
  type AttemptOperation,
  type DownloadAttempt,
} from './attempt.ts';

const INVALID_RESPONSE_REASON = 'The download service returned an invalid result.';
const DIRECT_REQUEST_REASON = 'The browser could not start this download.';
const FRAME_REQUEST_REASON = 'Frame export failed.';

interface UseDownloadAttemptOptions {
  executeFrame: (operation: AttemptOperation) => Promise<DownloadOperationResult>;
  executeDirect: (operations: readonly DownloadOperation[]) => Promise<unknown>;
  executeSilent?: (
    operations: readonly AttemptOperation[],
    onProgress: (requestId: string, phase: string, progress: number) => void,
    onPreflightComplete: () => void,
    approvedRequestIds: Set<string>
  ) => Promise<readonly DownloadOperationResult[]>;
  onAccepted?: (operations: readonly AttemptOperation[]) => void;
  onSettled?: (attempt: DownloadAttempt) => void;
}

function operationResult(
  operation: AttemptOperation,
  result: DownloadOperationResult | undefined,
  fallbackReason: string
): DownloadOperationResult {
  return (
    result ??
    DownloadFailedResult.make({
      requestId: operation.requestId,
      status: 'failed',
      reason: fallbackReason,
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
    (results: readonly DownloadOperationResult[]) => {
      const next = attemptReducer(attemptRef.current, { type: 'settle', results });
      if (!next) return;
      commit(next);
      const acceptedRequestIds = new Set(
        results.flatMap(result => (result.status === 'accepted' ? [result.requestId] : []))
      );
      const accepted = next.entries.flatMap(entry =>
        acceptedRequestIds.has(entry.operation.requestId) && entry.outcome.status === 'accepted'
          ? [entry.operation]
          : []
      );
      onAccepted?.(accepted);
      onSettled?.(next);
      if (summarizeAttempt(next).failed > 0) queueMicrotask(() => summaryRef.current?.focus());
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
            .then(results => settle(results))
            .catch(() => settle(failedResults(silent, 'Audio removal could not be completed.')))
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
                if (result.status === 'failed') throw new Error(FRAME_REQUEST_REASON);
              }
            );
            settle(
              frames.map(operation => {
                const batchResult = batch.find(result => result.index === operation.displayIndex);
                return operationResult(
                  operation,
                  outcomes.get(operation.requestId),
                  batchResult?.error ? FRAME_REQUEST_REASON : FRAME_REQUEST_REASON
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
                correlated.ok ? correlated.results : failedResults(direct, INVALID_RESPONSE_REASON)
              );
            } catch {
              settle(failedResults(direct, DIRECT_REQUEST_REASON));
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
    const operations = failedOperations(attemptRef.current);
    if (operations.length === 0) return;
    const next = attemptReducer(attemptRef.current, { type: 'retry' });
    commit(next);
    await submit(operations);
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
    clear,
    retryable: failedOperations(attempt),
    pending: pendingOperations(attempt),
  };
}
