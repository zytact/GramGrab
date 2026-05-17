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
