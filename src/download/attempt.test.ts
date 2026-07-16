import { describe, expect, it } from 'vite-plus/test';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadSkippedResult,
  requestIdFrom,
} from './contracts.ts';
import {
  attemptReducer,
  failedOperations,
  summarizeAttempt,
  type AttemptOperation,
} from './attempt.ts';

const operations: readonly AttemptOperation[] = [
  {
    requestId: requestIdFrom('00000000-0000-4000-8000-000000000010'),
    itemIndex: 0,
    url: 'https://cdn.instagram.com/a.jpg',
    filename: 'fixed-a.jpg',
    mediaType: 'image',
    mode: 'direct',
    displayIndex: 0,
  },
  {
    requestId: requestIdFrom('00000000-0000-4000-8000-000000000011'),
    itemIndex: 1,
    url: 'https://cdn.instagram.com/b.mp4',
    filename: 'fixed-frame.jpg',
    mediaType: 'video',
    mode: 'frame',
    displayIndex: 1,
    frameTimestampSeconds: 12,
  },
];

describe('download attempt reducer', () => {
  it('keeps skipped operations terminal and out of retry selection', () => {
    const fresh = attemptReducer(undefined, { type: 'fresh', operations: [operations[1]!] })!;
    const settled = attemptReducer(fresh, {
      type: 'settle',
      results: [
        DownloadSkippedResult.make({
          requestId: operations[1]!.requestId,
          status: 'skipped',
          reason: 'Re-encoding declined.',
        }),
      ],
    })!;
    expect(summarizeAttempt(settled).skipped).toBe(1);
    expect(failedOperations(settled)).toEqual([]);
    expect(attemptReducer(settled, { type: 'retry' })?.entries[0]?.outcome.status).toBe('skipped');
  });
  it('keeps accepted operations immutable across repeated targeted retries', () => {
    const fresh = attemptReducer(undefined, { type: 'fresh', operations })!;
    const settled = attemptReducer(fresh, {
      type: 'settle',
      results: [
        DownloadAcceptedResult.make({ requestId: operations[0]!.requestId, status: 'accepted' }),
        DownloadFailedResult.make({
          requestId: operations[1]!.requestId,
          status: 'failed',
          reason: 'Frame export failed.',
        }),
      ],
    })!;
    const retried = attemptReducer(settled, { type: 'retry' })!;
    expect(retried.entries.map(entry => entry.outcome.status)).toEqual(['accepted', 'pending']);
    expect(failedOperations(retried)).toEqual([]);
    const afterRetry = attemptReducer(retried, {
      type: 'settle',
      results: [
        DownloadAcceptedResult.make({ requestId: operations[1]!.requestId, status: 'accepted' }),
      ],
    })!;
    expect(summarizeAttempt(afterRetry)).toEqual({
      pending: 0,
      succeeded: 2,
      failed: 0,
      warnings: 0,
      skipped: 0,
    });
    expect(afterRetry.entries[1]!.operation).toMatchObject({
      requestId: operations[1]!.requestId,
      filename: 'fixed-frame.jpg',
      frameTimestampSeconds: 12,
    });
  });

  it('keeps selection-independent failures and counts accepted warnings as successes', () => {
    const fresh = attemptReducer(undefined, { type: 'fresh', operations })!;
    const settled = attemptReducer(fresh, {
      type: 'settle',
      results: [
        DownloadAcceptedResult.make({
          requestId: operations[0]!.requestId,
          status: 'accepted',
          warning: 'Download started, but history could not be saved.',
        }),
        DownloadFailedResult.make({
          requestId: operations[1]!.requestId,
          status: 'failed',
          reason: 'Frame export failed.',
        }),
      ],
    })!;
    expect(summarizeAttempt(settled)).toEqual({
      pending: 0,
      succeeded: 1,
      failed: 1,
      warnings: 1,
      skipped: 0,
    });
    expect(failedOperations(settled).map(operation => operation.requestId)).toEqual([
      operations[1]!.requestId,
    ]);
  });
});
