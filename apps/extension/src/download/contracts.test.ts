import { describe, expect, it } from 'vite-plus/test';
import { OperationFailure } from '../errors/contracts.ts';
import {
  DownloadFailedResult,
  DownloadMediaResponse,
  DownloadOperation,
  DownloadStartedResult,
  createOperationId,
  createRequestId,
  decodeDownloadMediaRequest,
  validateCorrelatedResults,
} from './contracts.ts';

const operation = (index: number) => {
  const url = `https://cdn.instagram.com/${index}.jpg`;
  const filename = `${index}.jpg`;
  return DownloadOperation.make({
    operationId: createOperationId(),
    requestId: createRequestId(),
    itemIndex: index,
    url,
    filename,
    originalUrl: url,
    originalFilename: filename,
    mediaType: 'image',
  });
};

describe('download contracts', () => {
  it('correlates each result by operation and request identity', () => {
    const first = operation(0);
    const second = operation(1);
    const response = DownloadMediaResponse.make({
      results: [
        DownloadStartedResult.make({
          operationId: first.operationId,
          requestId: first.requestId,
          status: 'started',
        }),
        DownloadFailedResult.make({
          operationId: second.operationId,
          requestId: second.requestId,
          status: 'failed',
          failure: OperationFailure.make({
            code: 'MEDIA_NETWORK_FAILED',
            phase: 'media-transfer',
            scope: 'item',
          }),
        }),
      ],
    });
    expect(validateCorrelatedResults([first, second], response)).toMatchObject({ ok: true });
  });

  it('rejects malformed operation identities at the request boundary', async () => {
    await expect(
      decodeDownloadMediaRequest({ operations: [{ requestId: 'bad' }] })
    ).rejects.toBeDefined();
  });

  it('rejects stale request results even when the operation ID matches', () => {
    const item = operation(0);
    const response = DownloadMediaResponse.make({
      results: [
        DownloadStartedResult.make({
          operationId: item.operationId,
          requestId: createRequestId(),
          status: 'started',
        }),
      ],
    });
    expect(validateCorrelatedResults([item], response)).toEqual({ ok: false });
  });
});
