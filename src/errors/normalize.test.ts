import { describe, expect, it } from 'vite-plus/test';
import { GraphQLRequestFailed, ResponseShapeUnknown } from '../effect/errors.ts';
import { normalizeBrowserDownloadFailure, normalizeSourceFailure } from './normalize.ts';

describe('operation failure normalization', () => {
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

  it('isolates string matching to the string-only browser adapter', () => {
    expect(normalizeBrowserDownloadFailure(new Error('Permission denied')).code).toBe(
      'BROWSER_DOWNLOAD_BLOCKED'
    );
    expect(normalizeBrowserDownloadFailure(new Error('disk full')).code).toBe(
      'BROWSER_DOWNLOAD_FILE_FAILED'
    );
  });
});
