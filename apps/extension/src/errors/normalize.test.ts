import { describe, expect, it } from 'vite-plus/test';
import {
  GraphQLRequestFailed,
  HttpError,
  InvalidInstagramUrl,
  NetworkError,
  ResponseShapeUnknown,
} from '../effect/errors.ts';
import {
  historyFailure,
  normalizeBrowserDownloadFailure,
  normalizeMediaTransferFailure,
  normalizeSourceFailure,
} from './normalize.ts';

describe('operation failure normalization', () => {
  it('normalizes an invalid source URL as a batch input rejection', () => {
    expect(
      normalizeSourceFailure(new InvalidInstagramUrl({ url: 'https://example.com' }))
    ).toMatchObject({
      code: 'INPUT_INVALID_SOURCE_URL',
      phase: 'input',
      scope: 'batch',
    });
  });

  it.each([
    [new GraphQLRequestFailed({ status: 401 }), 'IG_NOT_AUTHENTICATED'],
    [new GraphQLRequestFailed({ status: 403 }), 'IG_ACCESS_FORBIDDEN'],
    [new GraphQLRequestFailed({ status: 503 }), 'SOURCE_SERVER_FAILED'],
    [new ResponseShapeUnknown({ context: 'shortcode' }), 'IG_RESPONSE_SHAPE_UNKNOWN'],
  ])('normalizes typed source causes', (cause, code) => {
    const failure = normalizeSourceFailure(cause);

    expect(failure.code).toBe(code);
    expect(failure.scope).toBe('batch');
  });

  it.each([
    [new HttpError({ status: 403, message: 'Forbidden' }), 'MEDIA_URL_EXPIRED'],
    [new HttpError({ status: 404, message: 'Not Found' }), 'MEDIA_NOT_FOUND'],
    [new HttpError({ status: 500, message: 'Server Error' }), 'MEDIA_NETWORK_FAILED'],
    [new NetworkError({ cause: 'offline' }), 'MEDIA_NETWORK_FAILED'],
    ['something else entirely', 'MEDIA_UNEXPECTED_FAILURE'],
  ])('classifies a media transfer by its transport outcome', (cause, code) => {
    const failure = normalizeMediaTransferFailure(cause);

    expect(failure.code).toBe(code);
    expect(failure.phase).toBe('media-transfer');
    expect(failure.scope).toBe('item');
  });

  it('keeps history store failures free of any diagnostic cause', () => {
    for (const code of [
      'HISTORY_VERSION_UNSUPPORTED',
      'HISTORY_ENTRY_NOT_FOUND',
      'HISTORY_ITEM_UNRESOLVED',
      'HISTORY_STORE_FAILED',
    ] as const) {
      const failure = historyFailure(code);

      expect(failure).toEqual({
        platform: 'instagram',
        code,
        phase: 'history',
        scope: expect.any(String),
      });
    }
  });

  it('isolates string matching to the string-only browser adapter', () => {
    expect(normalizeBrowserDownloadFailure(new Error('Permission denied')).code).toBe(
      'BROWSER_DOWNLOAD_BLOCKED'
    );
    expect(normalizeBrowserDownloadFailure(new Error('disk full')).code).toBe(
      'BROWSER_DOWNLOAD_FILE_FAILED'
    );
  });
});
