import { Effect, Schema } from 'effect';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { configuredGraphqlHeaders, configuredRequests } from '../instagram/acquisition.ts';
import { graphqlFetch, graphqlPost } from '../effect/instagram.ts';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { MediaId, type TimedRef } from './contracts.ts';
import { WireAccountId } from './identity.ts';

const Seconds = Schema.Number.pipe(Schema.int(), Schema.positive());

const StoryFields = {
  id: MediaId,
  taken_at_timestamp: Seconds,
  expiring_at_timestamp: Seconds,
};

/** Only the Story variants a Watch understands. Any other item fails the whole acquisition. */
const StoryItem = Schema.Union(
  Schema.Struct({ __typename: Schema.Literal('GraphStoryImage'), ...StoryFields }),
  Schema.Struct({ __typename: Schema.Literal('GraphStoryVideo'), ...StoryFields })
);

const StoryReel = Schema.Struct({
  id: WireAccountId,
  owner: Schema.Struct({ id: WireAccountId }),
  items: Schema.Array(StoryItem),
});

const GraphqlError = Schema.Struct({
  path: Schema.optional(Schema.Array(Schema.Union(Schema.String, Schema.Number))),
});

const StoriesResponse = Schema.Struct({
  data: Schema.Struct({ reels_media: Schema.Array(StoryReel) }),
  errors: Schema.optional(Schema.Array(GraphqlError)),
});

/** Presentation leaves Instagram refuses to serve; every other error makes the answer untrusted. */
const OPTIONAL_STORY_FIELDS: ReadonlySet<unknown> = new Set(['story_cta_url', 'story_view_count']);

/** Story metadata may be at most this far in the future before it counts as malformed. */
const CLOCK_SKEW_SECONDS = 5 * 60;

const untrusted = () => new ResponseShapeUnknown({ context: 'watch_stories' });

/**
 * Reads the target's Story collection into exact references. Instagram answers an account without
 * active Stories with no reel. Another owner, several reels, a non-presentation GraphQL error, or an
 * item without trustworthy identity and timing fails instead of reading as "no Stories".
 */
export const readStories = (raw: unknown, targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const { data, errors = [] } = yield* Schema.decodeUnknown(StoriesResponse)(raw).pipe(
      Effect.mapError(untrusted)
    );
    if (errors.some(error => !OPTIONAL_STORY_FIELDS.has(error.path?.at(-1))))
      return yield* Effect.fail(untrusted());
    const [reel, ...others] = data.reels_media;
    if (!reel) return [];
    if (others.length > 0 || reel.id !== targetId || reel.owner.id !== targetId)
      return yield* Effect.fail(untrusted());
    const timed = reel.items.every(
      item =>
        item.taken_at_timestamp <= nowSeconds + CLOCK_SKEW_SECONDS &&
        item.expiring_at_timestamp > item.taken_at_timestamp
    );
    if (!timed) return yield* Effect.fail(untrusted());
    return reel.items.map(
      (item): TimedRef => ({
        _tag: 'Story',
        mediaId: item.id,
        mediaType: item.__typename === 'GraphStoryVideo' ? 'video' : 'image',
        takenAt: item.taken_at_timestamp,
        expiresAt: item.expiring_at_timestamp,
      })
    );
  });

const STORY_VARIABLES = (targetId: string) => ({
  reel_ids: [targetId],
  highlight_reel_ids: [],
  location_ids: [],
  precomposed_overlay: false,
});

const stopsFallback = (error: { readonly _tag: string }) =>
  error._tag === 'RateLimited' || error._tag === 'WatchRequestDeferred';

/**
 * Fetches the target's Stories by account ID, trying each configured request in turn. Throttling
 * stops at once rather than spending another request.
 */
export const fetchStories = (targetId: string) => {
  const [first, ...rest] = configuredRequests(protocolConfig.operations.reelsMedia).map(
    ({ candidate, request }) => {
      const key = candidate.kind === 'client_doc_id' ? 'doc_id' : candidate.kind;
      const headers = configuredGraphqlHeaders(request);
      const variables = STORY_VARIABLES(targetId);
      return request.transport === 'form'
        ? graphqlPost(request.endpoint, candidate.id, variables, headers, key)
        : graphqlFetch(request.endpoint, key, candidate.id, variables, headers);
    }
  );
  return rest.reduce(
    (previous, next) =>
      previous.pipe(
        Effect.catchIf(
          error => !stopsFallback(error),
          () => next
        )
      ),
    first!
  );
};
