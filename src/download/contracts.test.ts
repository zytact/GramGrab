import { describe, expect, it } from 'vite-plus/test';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadMediaResponse,
  DownloadOperation,
  createRequestId,
  decodeDownloadMediaRequest,
  requestIdFrom,
  validateCorrelatedResults,
} from './contracts.ts';

const first = DownloadOperation.make({
  requestId: requestIdFrom('00000000-0000-4000-8000-000000000001'),
  itemIndex: 0,
  url: 'https://cdn.instagram.com/duplicate.jpg',
  filename: 'first.jpg',
  mediaType: 'image',
});
const second = DownloadOperation.make({
  requestId: requestIdFrom('00000000-0000-4000-8000-000000000002'),
  itemIndex: 1,
  url: 'https://cdn.instagram.com/duplicate.jpg',
  filename: 'second.jpg',
  mediaType: 'image',
});

describe('download contracts', () => {
  it('creates valid UUID operation identities independently of duplicate URLs', () => {
    expect(createRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const response = DownloadMediaResponse.make({
      results: [
        DownloadAcceptedResult.make({ requestId: first.requestId, status: 'accepted' }),
        DownloadFailedResult.make({
          requestId: second.requestId,
          status: 'failed',
          reason: 'Retry later.',
        }),
      ],
    });
    expect(validateCorrelatedResults([first, second], response)).toMatchObject({ ok: true });
  });

  it('rejects malformed operations at the request boundary', async () => {
    await expect(
      decodeDownloadMediaRequest({
        operations: [
          {
            requestId: 'not-a-uuid',
            itemIndex: 0,
            url: 'x',
            filename: 'a.jpg',
            mediaType: 'image',
          },
        ],
      })
    ).rejects.toBeDefined();
  });

  it.each([
    [
      DownloadMediaResponse.make({
        results: [DownloadAcceptedResult.make({ requestId: first.requestId, status: 'accepted' })],
      }),
      'missing',
    ],
    [
      DownloadMediaResponse.make({
        results: [
          DownloadAcceptedResult.make({ requestId: first.requestId, status: 'accepted' }),
          DownloadFailedResult.make({
            requestId: first.requestId,
            status: 'failed',
            reason: 'Duplicate.',
          }),
        ],
      }),
      'duplicate',
    ],
    [
      DownloadMediaResponse.make({
        results: [
          DownloadAcceptedResult.make({ requestId: first.requestId, status: 'accepted' }),
          DownloadAcceptedResult.make({
            requestId: requestIdFrom('00000000-0000-4000-8000-000000000003'),
            status: 'accepted',
          }),
        ],
      }),
      'unknown',
    ],
  ])('rejects %s correlations', response => {
    expect(validateCorrelatedResults([first, second], response)).toEqual({ ok: false });
  });
});
