import { Data } from 'effect';
import type { CheckIncompleteReason } from '@gramgrab/protocol';

// URL parsing
export class InvalidInstagramUrl extends Data.TaggedError('InvalidInstagramUrl')<{ url: string }> {}

// Username resolution
export class UsernameUnresolved extends Data.TaggedError('UsernameUnresolved')<{
  username: string;
}> {}

// Network / HTTP
export class NetworkError extends Data.TaggedError('NetworkError')<{ cause: unknown }> {}
export class HttpError extends Data.TaggedError('HttpError')<{ status: number; message: string }> {}
export class RateLimited extends Data.TaggedError('RateLimited')<{ status: 429 }> {}

/** The operation asked for the linked login while none is linked, or after its session ended. */
export class LinkedLoginUnavailable extends Data.TaggedError('LinkedLoginUnavailable')<{
  reason: 'missing' | 'ended';
}> {}

// GraphQL path
export class GraphQLRequestFailed extends Data.TaggedError('GraphQLRequestFailed')<{
  status: number;
}> {}

// Media normalization
export class MediaNotFound extends Data.TaggedError('MediaNotFound')<{ hint: string }> {}
export class ResponseShapeUnknown extends Data.TaggedError('ResponseShapeUnknown')<{
  context: string;
}> {}
/** Instagram answered, but not with something to trust as complete and consistent. */
export class AnswerUntrusted extends Data.TaggedError('AnswerUntrusted')<{
  readonly reason: CheckIncompleteReason;
}> {}
export class MediaDashOnlyUnsupported extends Data.TaggedError('MediaDashOnlyUnsupported')<{
  mediaId: string;
}> {}

// Frame extraction (Phase 7+)
export class VideoFrameExtractionFailed extends Data.TaggedError('VideoFrameExtractionFailed')<{
  reason: 'no-duration' | 'no-frame' | 'no-canvas' | 'no-blob' | 'timeout';
}> {}
