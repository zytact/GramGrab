import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  DownloadOperation,
  operationIdFrom,
  requestIdFrom,
  type DownloadOperation as DownloadOperationType,
} from '../download/contracts.ts';
import type { AttemptOperation, DownloadAttempt } from '../download/attempt.ts';
import { diagnosticCause, OperationFailure, OperationWarning } from './contracts.ts';
import {
  buildDiagnostics,
  DiagnosticsReport,
  makeDiagnostics,
  type DiagnosticsInput,
} from './diagnostics.ts';

const capturedAt = new Date('2026-07-16T12:00:00.000Z');
const expiredAt = new Date('2026-07-16T11:00:00.000Z');
const expiredAtHex = Math.floor(expiredAt.getTime() / 1000).toString(16);

function operation(
  operationId: string,
  requestId: string,
  url: string,
  mediaType: 'image' | 'video'
): AttemptOperation {
  const downloadOperation: DownloadOperationType = DownloadOperation.make({
    operationId: operationIdFrom(operationId),
    requestId: requestIdFrom(requestId),
    itemIndex: 0,
    url,
    filename: 'FILENAME_SECRET.mp4',
    originalUrl: url,
    originalFilename: 'ORIGINAL_FILENAME_SECRET.mp4',
    mediaType,
  });
  return {
    operationId: downloadOperation.operationId,
    requestId: downloadOperation.requestId,
    itemIndex: downloadOperation.itemIndex,
    mediaId: downloadOperation.mediaId,
    url: downloadOperation.url,
    filename: downloadOperation.filename,
    originalUrl: downloadOperation.originalUrl,
    originalFilename: downloadOperation.originalFilename,
    mediaType: downloadOperation.mediaType,
    mode: 'direct',
    displayIndex: 0,
  };
}

describe('attempt diagnostics', () => {
  it('builds and encodes a closed structural-only report', () => {
    const signedMediaUrl =
      `https://SCONTENT-FRA3-1.CDNINSTAGRAM.COM/v/t51/PRIVATE_PATH_SECRET/photo.jpg` +
      `?unexpected=UNEXPECTED_QUERY_SECRET&_nc_sid=SID_VALUE_SECRET&oh=HASH_VALUE_SECRET&oe=${expiredAtHex}`;
    const malformedUrl = 'not-a-url-MALFORMED_URL_SECRET';
    const firstOperationId = '00000000-0000-4000-8000-000000000001';
    const firstRequestId = '10000000-0000-4000-8000-000000000001';
    const secondOperationId = '00000000-0000-4000-8000-000000000002';
    const secondRequestId = '10000000-0000-4000-8000-000000000002';

    const warningError = new Error('WARNING_MESSAGE_SECRET');
    warningError.name = 'WARNING_NAME_SECRET';
    warningError.stack = 'WARNING_STACK_SECRET';
    const failureError = new Error('FAILURE_MESSAGE_SECRET');
    failureError.name = 'FAILURE_NAME_SECRET';
    failureError.stack = 'FAILURE_STACK_SECRET';
    const batchError = new Error('BATCH_MESSAGE_SECRET');
    batchError.name = 'BATCH_NAME_SECRET';
    batchError.stack = 'BATCH_STACK_SECRET';

    const warning = OperationWarning.make({
      code: 'HISTORY_SAVE_FAILED',
      cause: diagnosticCause(warningError),
    });
    const failure = OperationFailure.make({
      code: 'DOWNLOAD_UNEXPECTED_FAILURE',
      phase: 'browser-download',
      scope: 'item',
      cause: diagnosticCause(failureError),
    });
    const batchFailure = OperationFailure.make({
      code: 'IG_RESPONSE_SHAPE_UNKNOWN',
      phase: 'source',
      scope: 'batch',
      cause: diagnosticCause(batchError),
    });
    const attempt: DownloadAttempt = {
      entries: [
        {
          operation: operation(firstOperationId, firstRequestId, signedMediaUrl, 'image'),
          outcome: { status: 'started', warning },
          executionCount: 2,
          manualRetryCount: 1,
        },
        {
          operation: operation(secondOperationId, secondRequestId, malformedUrl, 'video'),
          outcome: { status: 'failed', failure },
          executionCount: 3,
          manualRetryCount: 2,
        },
      ],
      batchFailure,
    };
    const fullUserAgent =
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36 FULL_USER_AGENT_SECRET';
    const sourceUrl = 'https://www.instagram.com/p/SOURCE_URL_SECRET/';

    const report = makeDiagnostics(
      {
        extensionVersion: '1.2.3',
        userAgent: fullUserAgent,
        sourceUrl,
        attempt,
        batchFailure,
      },
      capturedAt
    );
    const json = buildDiagnostics(
      {
        extensionVersion: '1.2.3',
        userAgent: fullUserAgent,
        sourceUrl,
        attempt,
        batchFailure,
      },
      capturedAt
    );
    const parsed = JSON.parse(json);

    expect(report.diagnosticsVersion).toBe(2);
    expect(report.browser).toEqual({ family: 'chromium', majorVersion: 124, platform: 'linux' });
    expect(report.attempt).toEqual({
      entries: [
        { executionCount: 2, manualRetryCount: 1 },
        { executionCount: 3, manualRetryCount: 2 },
      ],
    });
    expect(report.items[0]?.mediaUrl).toEqual({
      parseStatus: 'parsed',
      hostname: 'scontent-fra3-1.cdninstagram.com',
      pathSegmentCount: 4,
      pathExtension: 'jpg',
      queryParameterNames: ['_nc_sid', 'oe', 'oh', 'unexpected'],
      signatureParameters: {
        _nc_cat: false,
        _nc_ohc: false,
        _nc_sid: true,
        ccb: false,
        efg: false,
        oh: true,
        oe: true,
        se: false,
        st: false,
      },
      expiresAt: expiredAt.toISOString(),
      expiredAtCapture: true,
    });
    expect(report.items[0]?.outcome).toEqual({
      status: 'started',
      warning: { code: 'HISTORY_SAVE_FAILED' },
    });
    expect(report.items[1]?.mediaUrl).toEqual({ parseStatus: 'invalid' });
    expect(report.items[1]?.outcome).toEqual({
      status: 'failed',
      failure: {
        code: 'DOWNLOAD_UNEXPECTED_FAILURE',
        phase: 'browser-download',
        scope: 'item',
      },
    });
    expect(report.batchFailure).toEqual({
      code: 'IG_RESPONSE_SHAPE_UNKNOWN',
      phase: 'source',
      scope: 'batch',
    });
    expect(report.warnings).toEqual([{ code: 'HISTORY_SAVE_FAILED' }]);
    expect(Schema.decodeUnknownSync(DiagnosticsReport)(parsed)).toEqual(report);
    expect(() =>
      Schema.decodeUnknownSync(DiagnosticsReport)({ ...parsed, diagnosticsVersion: 1 })
    ).toThrow();

    const secrets = [
      signedMediaUrl,
      sourceUrl,
      'FILENAME_SECRET',
      'ORIGINAL_FILENAME_SECRET',
      'WARNING_MESSAGE_SECRET',
      'WARNING_NAME_SECRET',
      'WARNING_STACK_SECRET',
      'FAILURE_MESSAGE_SECRET',
      'FAILURE_NAME_SECRET',
      'FAILURE_STACK_SECRET',
      'BATCH_MESSAGE_SECRET',
      'BATCH_NAME_SECRET',
      'BATCH_STACK_SECRET',
      firstOperationId,
      firstRequestId,
      secondOperationId,
      secondRequestId,
      fullUserAgent,
      malformedUrl,
      'UNEXPECTED_QUERY_SECRET',
      'SID_VALUE_SECRET',
      'HASH_VALUE_SECRET',
    ];
    for (const secret of secrets) expect(json).not.toContain(secret);
    for (const excludedField of [
      'sourceUrl',
      'temporaryMediaUrl',
      'filename',
      'operationId',
      'requestId',
      'userAgent',
      'cause',
      'message',
      'stack',
    ]) {
      expect(json).not.toContain(excludedField);
    }
  });

  it('does not emit a dotless final path segment as an extension', () => {
    const dotlessPathSecret = 'dotless7';
    const input: DiagnosticsInput = {
      extensionVersion: '1.2.3',
      userAgent: '',
      attempt: {
        entries: [
          {
            operation: operation(
              '00000000-0000-4000-8000-000000000004',
              '10000000-0000-4000-8000-000000000004',
              `https://cdn.example/private/${dotlessPathSecret}`,
              'image'
            ),
            outcome: { status: 'not-attempted' },
            executionCount: 1,
            manualRetryCount: 0,
          },
        ],
      },
    };
    const report = makeDiagnostics(input, capturedAt);
    const json = buildDiagnostics(input, capturedAt);

    expect(report.items[0]?.mediaUrl).toMatchObject({
      parseStatus: 'parsed',
      pathExtension: null,
    });
    expect(json).not.toContain(dotlessPathSecret);
  });

  it('does not fall back to malformed URL input and uses unknown UA descriptors', () => {
    const report = makeDiagnostics(
      {
        extensionVersion: '1.2.3',
        userAgent: 'UNKNOWN_BROWSER FULL_USER_AGENT_SECRET',
        attempt: {
          entries: [
            {
              operation: operation(
                '00000000-0000-4000-8000-000000000003',
                '10000000-0000-4000-8000-000000000003',
                '%%% MALFORMED_URL_SECRET',
                'image'
              ),
              outcome: { status: 'not-attempted' },
              executionCount: 1,
              manualRetryCount: 0,
            },
          ],
        },
      },
      capturedAt
    );

    expect(report.browser).toEqual({ family: 'unknown', majorVersion: null, platform: 'unknown' });
    expect(report.items[0]?.mediaUrl).toEqual({ parseStatus: 'invalid' });
    expect(buildDiagnostics({ extensionVersion: '1.2.3', userAgent: '' }, capturedAt)).toContain(
      '"diagnosticsVersion": 2'
    );
  });
});
