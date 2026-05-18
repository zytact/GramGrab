import { Data } from 'effect';

// URL parsing
export class InvalidInstagramUrl extends Data.TaggedError('InvalidInstagramUrl')<{ url: string }> {}

// Username resolution
export class UsernameUnresolved extends Data.TaggedError('UsernameUnresolved')<{
  username: string;
}> {}

// Network / HTTP
export class NetworkError extends Data.TaggedError('NetworkError')<{ cause: unknown }> {}
export class HttpError extends Data.TaggedError('HttpError')<{ status: number; message: string }> {}

// These derive from HttpError.status — new behavior enrichment (Phase 3+)
export class NotAuthenticated extends Data.TaggedError('NotAuthenticated')<{ status: 401 }> {}
export class Forbidden extends Data.TaggedError('Forbidden')<{ status: 403 }> {}
export class RateLimited extends Data.TaggedError('RateLimited')<{ status: 429 }> {}

// GraphQL path
export class GraphQLRequestFailed extends Data.TaggedError('GraphQLRequestFailed')<{
  status: number;
}> {}

// Media normalization
export class MediaNotFound extends Data.TaggedError('MediaNotFound')<{ hint: string }> {}
export class ResponseShapeUnknown extends Data.TaggedError('ResponseShapeUnknown')<{
  context: string;
}> {}

// Downloads
export class BrowserDownloadFailed extends Data.TaggedError('BrowserDownloadFailed')<{
  url: string;
  cause: unknown;
}> {}

// Frame extraction (Phase 7+)
export class VideoFrameExtractionFailed extends Data.TaggedError('VideoFrameExtractionFailed')<{
  reason: 'no-duration' | 'no-frame' | 'no-canvas' | 'no-blob' | 'cors' | 'timeout';
}> {}

export function formatError(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('_tag' in err)) {
    return String(err);
  }
  const e = err as Record<string, unknown>;
  switch (e['_tag']) {
    case 'InvalidInstagramUrl':
      return `Invalid Instagram URL: ${String(e['url'])}`;
    case 'UsernameUnresolved':
      return `Could not resolve username: ${String(e['username'])}`;
    case 'NetworkError':
      return String(e['cause']);
    case 'HttpError':
      return `HTTP ${String(e['status'])}`;
    case 'NotAuthenticated':
      return 'HTTP 401';
    case 'Forbidden':
      return 'HTTP 403';
    case 'RateLimited':
      return 'HTTP 429';
    case 'GraphQLRequestFailed':
      return `GraphQL failed: ${String(e['status'])}`;
    case 'MediaNotFound':
      return `No media found: ${String(e['hint'])}`;
    case 'ResponseShapeUnknown':
      return `Unexpected response shape: ${String(e['context'])}`;
    case 'BrowserDownloadFailed':
      return `Download failed for ${String(e['url'])}: ${String(e['cause'])}`;
    case 'VideoFrameExtractionFailed':
      return `Frame extraction failed: ${String(e['reason'])}`;
    default:
      return String(err);
  }
}
