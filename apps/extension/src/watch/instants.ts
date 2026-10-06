import { Effect, Either } from 'effect';
import type { InstantItem } from '../effect/schemas.ts';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { fetchInstantItems } from '../instagram/acquisition.ts';
import type { TimedRef } from './contracts.ts';

const CLOCK_SKEW_SECONDS = 5 * 60;
/** An Instant's ID is its media ID and its owner's account ID, joined. */
const INSTANT_ID = /^(\d{1,30})_(\d{1,30})$/;

const untrusted = () => new ResponseShapeUnknown({ context: 'watch_instants' });

type FeedResult = Either.Either<
  readonly InstantItem[],
  Effect.Effect.Error<ReturnType<typeof fetchInstantItems>>
>;

/** The one feed answer shared by the Watches of a scope, held in memory only. */
let shared: { readonly scope: string; readonly result: FeedResult } | undefined;

/**
 * The viewer's active Instants feed, fetched once per `scope` and reused by every Watch checked in
 * it. A scope names one verified login's round or person-initiated check, so a feed never crosses
 * logins or rounds. Throttling is not shared: the next Watch asks again once it may.
 */
export const sharedInstantsFeed = (scope: string) =>
  Effect.suspend(() => {
    if (shared?.scope === scope) return shared.result;
    return Effect.either(fetchInstantItems()).pipe(
      Effect.tap(result => {
        const throttled =
          Either.isLeft(result) &&
          (result.left._tag === 'RateLimited' || result.left._tag === 'WatchRequestDeferred');
        if (!throttled) shared = { scope, result };
      }),
      Effect.flatten
    );
  });

/** An item's exact reference, or undefined unless it is a known, owner-bound, trustworthy one. */
function toRef(item: InstantItem, nowSeconds: number): TimedRef | undefined {
  if (item.__typename !== 'XDTMediaDict' || !('media_type' in item)) return undefined;
  const timed =
    Number.isInteger(item.taken_at) &&
    item.taken_at > 0 &&
    item.taken_at <= nowSeconds + CLOCK_SKEW_SECONDS;
  if (!timed || INSTANT_ID.exec(item.id)?.[2] !== item.user.id) return undefined;
  return {
    _tag: 'Instant',
    mediaId: item.id,
    mediaType: item.media_type === 1 ? 'image' : 'video',
    takenAt: item.taken_at,
  };
}

/**
 * Reads the target's Instants from the whole feed, in whatever order it came. Every item must be
 * a known photo or video with an exact owner-bound ID and a trustworthy publication time, or the
 * feed is not trusted for any Watch.
 */
export const readInstants = (items: readonly InstantItem[], targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const refs = items.map(item => toRef(item, nowSeconds));
    const trusted = refs.filter(ref => ref !== undefined);
    if (trusted.length !== refs.length) return yield* Effect.fail(untrusted());
    return trusted.filter(ref => ref.mediaId.endsWith(`_${targetId}`));
  });
