import { Effect, Schema } from 'effect';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { MediaId, type TimedRef } from './contracts.ts';
import { WireAccountId } from './identity.ts';

const Seconds = Schema.Number.pipe(Schema.int(), Schema.positive());

/** Only the Story variants a Watch understands. Any other item fails the whole acquisition. */
const StoryItem = Schema.Struct({
  __typename: Schema.Literal('XDTMediaDict'),
  pk: MediaId,
  media_type: Schema.Literal(1, 2),
  taken_at: Seconds,
  expiring_at: Seconds,
});

const StoryReel = Schema.Struct({
  id: WireAccountId,
  user: Schema.Struct({ pk: WireAccountId }),
  items: Schema.Array(StoryItem),
});

const StoriesResponse = Schema.Struct({
  data: Schema.Struct({
    xdt_api__v1__feed__reels_media: Schema.Struct({ reels_media: Schema.Array(StoryReel) }),
  }),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Story metadata may be at most this far in the future before it counts as malformed. */
const CLOCK_SKEW_SECONDS = 5 * 60;

const untrusted = () => new ResponseShapeUnknown({ context: 'watch_stories' });

/**
 * Reads the target's Story collection into exact references. Instagram answers an account without
 * active Stories with no reel. Another owner, several reels, any GraphQL error, or an item without
 * trustworthy identity and timing fails instead of reading as "no Stories".
 */
export const readStories = (raw: unknown, targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const { data, errors = [] } = yield* Schema.decodeUnknown(StoriesResponse)(raw).pipe(
      Effect.mapError(untrusted)
    );
    if (errors.length > 0) return yield* Effect.fail(untrusted());
    const [reel, ...others] = data.xdt_api__v1__feed__reels_media.reels_media;
    if (!reel) return [];
    if (others.length > 0 || reel.id !== targetId || reel.user.pk !== targetId)
      return yield* Effect.fail(untrusted());
    const timed = reel.items.every(
      item => item.taken_at <= nowSeconds + CLOCK_SKEW_SECONDS && item.expiring_at > item.taken_at
    );
    if (!timed) return yield* Effect.fail(untrusted());
    return reel.items.map(
      (item): TimedRef => ({
        _tag: 'Story',
        mediaId: item.pk,
        mediaType: item.media_type === 2 ? 'video' : 'image',
        takenAt: item.taken_at,
        expiresAt: item.expiring_at,
      })
    );
  });
