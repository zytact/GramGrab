import { describe, expect, it } from 'vite-plus/test';
import { OperationFailure, OperationWarning } from '../errors/contracts.ts';
import {
  createOperationId,
  createRequestId,
  DownloadFailedResult,
  DownloadNotAttemptedResult,
  DownloadStartedResult,
} from './contracts.ts';
import {
  attemptReducer,
  failedOperations,
  summarizeAttempt,
  type AttemptOperation,
} from './attempt.ts';

const operation = (): AttemptOperation => ({
  operationId: createOperationId(),
  requestId: createRequestId(),
  itemIndex: 0,
  url: 'https://cdn.instagram.com/a.jpg',
  filename: 'a.jpg',
  originalUrl: 'https://cdn.instagram.com/a.jpg',
  originalFilename: 'a.jpg',
  mediaType: 'image',
  mode: 'direct',
  displayIndex: 0,
});

describe('download attempt reducer', () => {
  it('keeps operation identity stable and creates a fresh request identity for retry', () => {
    const item = operation();
    const fresh = attemptReducer(undefined, { type: 'fresh', operations: [item] })!;
    const settled = attemptReducer(fresh, {
      type: 'settle',
      results: [
        DownloadFailedResult.make({
          operationId: item.operationId,
          requestId: item.requestId,
          status: 'failed',
          failure: OperationFailure.make({
            code: 'MEDIA_NETWORK_FAILED',
            phase: 'media-transfer',
            scope: 'item',
          }),
        }),
      ],
    })!;
    expect(failedOperations(settled)).toHaveLength(1);
    const retried = attemptReducer(settled, { type: 'retry' })!;
    expect(retried.entries[0]?.operation.operationId).toBe(item.operationId);
    expect(retried.entries[0]?.operation.requestId).not.toBe(item.requestId);
    expect(retried.entries[0]).toMatchObject({ executionCount: 2, manualRetryCount: 1 });
  });

  it('tracks retry allowance per operation in a mixed-mode batch', () => {
    const direct = operation();
    const frame = { ...operation(), mode: 'frame' as const, displayIndex: 1 };
    const networkFailure = OperationFailure.make({
      code: 'MEDIA_NETWORK_FAILED',
      phase: 'media-transfer',
      scope: 'item',
    });
    const fresh = attemptReducer(undefined, { type: 'fresh', operations: [direct, frame] })!;
    const settled = attemptReducer(fresh, {
      type: 'settle',
      results: [direct, frame].map(item =>
        DownloadFailedResult.make({
          operationId: item.operationId,
          requestId: item.requestId,
          status: 'failed',
          failure: networkFailure,
        })
      ),
    })!;
    const retried = attemptReducer(settled, {
      type: 'retry',
      operationIds: new Set([direct.operationId]),
    })!;
    const retriedDirect = retried.entries[0]!;
    const untouchedFrame = retried.entries[1]!;
    const failedAgain = attemptReducer(retried, {
      type: 'settle',
      results: [
        DownloadFailedResult.make({
          operationId: retriedDirect.operation.operationId,
          requestId: retriedDirect.operation.requestId,
          status: 'failed',
          failure: networkFailure,
        }),
      ],
    })!;
    expect(untouchedFrame).toMatchObject({ executionCount: 1, manualRetryCount: 0 });
    expect(failedOperations(failedAgain).map(item => item.operationId)).toEqual([
      frame.operationId,
    ]);
  });

  it('lets a batch storage prerequisite failure fall back not-attempted items to originals', () => {
    const silent = {
      ...operation(),
      mode: 'silent' as const,
      filename: 'a_silent.mp4',
      originalFilename: 'a.mp4',
      mediaType: 'video' as const,
    };
    const batchFailure = OperationFailure.make({
      code: 'SILENT_STORAGE_UNAVAILABLE',
      phase: 'silent-storage',
      scope: 'batch',
    });
    const fresh = attemptReducer(undefined, { type: 'fresh', operations: [silent] })!;
    const blocked = attemptReducer(fresh, {
      type: 'settle',
      batchFailure,
      results: [
        DownloadNotAttemptedResult.make({
          operationId: silent.operationId,
          requestId: silent.requestId,
          status: 'not-attempted',
        }),
      ],
    })!;
    expect(blocked.batchFailure).toBe(batchFailure);
    expect(summarizeAttempt(blocked).notAttempted).toBe(1);
    const fallback = attemptReducer(blocked, {
      type: 'fallback-original',
      operationIds: new Set([silent.operationId]),
    })!;
    expect(fallback.entries[0]).toMatchObject({
      operation: { operationId: silent.operationId, filename: 'a.mp4', mode: 'direct' },
      outcome: { status: 'pending' },
      executionCount: 2,
      manualRetryCount: 0,
    });
    expect(fallback.entries[0]?.operation.requestId).not.toBe(silent.requestId);
  });

  it('counts started warnings without treating browser acceptance as completion', () => {
    const item = operation();
    const fresh = attemptReducer(undefined, { type: 'fresh', operations: [item] })!;
    const settled = attemptReducer(fresh, {
      type: 'settle',
      results: [
        DownloadStartedResult.make({
          operationId: item.operationId,
          requestId: item.requestId,
          status: 'started',
          warning: OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' }),
        }),
      ],
    })!;
    expect(summarizeAttempt(settled)).toEqual({
      pending: 0,
      started: 1,
      failed: 0,
      warnings: 1,
      skipped: 0,
      notAttempted: 0,
    });
  });
});
