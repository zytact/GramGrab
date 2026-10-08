import { Effect, Either, Schema } from 'effect';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { ReelsMediaResponseSchema } from '../effect/schemas.ts';
import { historySource } from '../history/source.ts';
import type { DownloadHistoryEntry } from '../history/contracts.ts';
import { fetchInstantItems } from '../instagram/acquisition.ts';
import {
  normalizeInstantItems,
  normalizeReelsMediaItems,
  type MediaItem,
} from '../instagram/normalize.ts';
import { fetchRestShortcodeMedia } from '../instagram/rest-shortcode.ts';
import type { Discovery, MediaRef, Watch } from './contracts.ts';
import { fetchAvatar, readAvatar } from './avatar.ts';
import { readInstants } from './instants.ts';
import { fetchStories, readStories } from './stories.ts';
import { fetchViewer } from './identity.ts';
import { readStore } from './store.ts';

export type Unavailable = NonNullable<Discovery['unavailable']>;

/** One file of an entry: found afresh, or shown gone by a supported, valid answer. */
export type Slot =
  | { readonly _tag: 'found'; readonly item: MediaItem }
  | { readonly _tag: 'gone'; readonly code: Unavailable };

const gone = (code: Unavailable): Slot => ({ _tag: 'gone', code });

const untrusted = () => new ResponseShapeUnknown({ context: 'watch_export' });

/**
 * The one fresh item with this exact identity and type. Its absence is `absent`; two matches, or
 * one of another type, make the answer untrusted rather than substitute media.
 */
const exact = (
  items: readonly MediaItem[],
  ref: { readonly mediaId: string; readonly mediaType: 'image' | 'video' },
  absent: Unavailable
) => {
  const matches = items.filter(item => item.mediaId === ref.mediaId);
  if (matches.length === 0) return Effect.succeed(gone(absent));
  const [match] = matches;
  return matches.length === 1 && match!.type === ref.mediaType
    ? Effect.succeed<Slot>({ _tag: 'found', item: match! })
    : Effect.fail(untrusted());
};

/** A Post or Sidecar by its shortcode, over REST only. An empty answer is not trusted as absence. */
const restItems = (watch: Watch, ref: Extract<MediaRef, { _tag: 'Post' | 'Sidecar' }>) =>
  fetchRestShortcodeMedia(ref.shortcode, {
    parentId: ref.mediaId,
    accountId: watch.targetId,
    mediaType: ref._tag === 'Sidecar' ? 8 : ref.mediaType === 'image' ? 1 : 2,
    ...(ref._tag === 'Sidecar' ? { children: ref.children } : {}),
  }).pipe(Effect.filterOrFail(items => items.length > 0, untrusted));

const storyItems = (targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const raw = yield* fetchStories(targetId);
    yield* readStories(raw, targetId, nowSeconds);
    const { data } = yield* Schema.decodeUnknown(ReelsMediaResponseSchema)(raw).pipe(
      Effect.mapError(untrusted)
    );
    return normalizeReelsMediaItems(data.reels_media, 'story');
  });

const instantItems = (targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const items = yield* fetchInstantItems();
    yield* readInstants(items, targetId, nowSeconds);
    return yield* normalizeInstantItems(items);
  });

const avatarSlot = (watch: Watch, pictureId: string) =>
  Effect.gen(function* () {
    const raw = yield* fetchAvatar(watch.username);
    const current = yield* readAvatar(raw, watch.targetId, watch.username);
    if (current.pictureId !== pictureId) return gone('WATCH_AVATAR_CHANGED');
    if (!current.pictureUrl) return yield* Effect.fail(untrusted());
    return {
      _tag: 'found',
      item: {
        itemIndex: 0,
        mediaId: `profile-avatar:${watch.username}`,
        type: 'image',
        url: current.pictureUrl,
        filenameHint: `${watch.username}_profile`,
      },
    } satisfies Slot;
  });

/**
 * Finds the exact recorded media of `ref` afresh, one slot per file: a Sidecar's frozen children
 * in order, or the item itself. A Story already expired fails without a request.
 */
export const reacquire = Effect.fn(function* (watch: Watch, ref: MediaRef, nowSeconds: number) {
  switch (ref._tag) {
    case 'Post':
      return [yield* exact(yield* restItems(watch, ref), ref, 'WATCH_MEDIA_UNAVAILABLE')];
    case 'Sidecar': {
      const items = yield* restItems(watch, ref);
      return yield* Effect.forEach(ref.children, child =>
        exact(items, child, 'WATCH_MEDIA_UNAVAILABLE')
      );
    }
    case 'Story':
      if (ref.expiresAt <= nowSeconds) return [gone('WATCH_STORY_EXPIRED')];
      return [
        yield* exact(yield* storyItems(watch.targetId, nowSeconds), ref, 'WATCH_MEDIA_UNAVAILABLE'),
      ];
    case 'Instant':
      return [
        yield* exact(
          yield* instantItems(watch.targetId, nowSeconds),
          ref,
          'WATCH_INSTANT_NOT_IN_FEED'
        ),
      ];
    case 'Avatar':
      return [yield* avatarSlot(watch, ref.pictureId)];
  }
});

/** Where a History receipt says the media came from. */
export function historyOrigin(watch: Watch, ref: MediaRef): DownloadHistoryEntry['origin'] {
  if (ref._tag === 'Instant') return { kind: 'instants' };
  const url =
    ref._tag === 'Story'
      ? `https://www.instagram.com/stories/${watch.username}/`
      : ref._tag === 'Avatar'
        ? `https://www.instagram.com/${watch.username}/`
        : `https://www.instagram.com/p/${ref.shortcode}/`;
  const source = historySource(url)!;
  return { kind: 'source', sourceUrl: source.url, sourceKind: source.kind };
}

export function originalFilename(item: MediaItem, index: number): string {
  return `${item.filenameHint}_${index + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`;
}

/** What exporting an entry newly showed about its availability, kept on the discovery. */
export interface Learned {
  readonly unavailable?: Unavailable;
  readonly missingChildren?: readonly string[];
}

export const exportAuthorization = Effect.fn(function* (watch: Watch, discovery: Discovery) {
  const viewer = yield* Effect.either(fetchViewer);
  if (Either.isLeft(viewer) || viewer.right.accountId !== watch.viewerId)
    return 'IG_NOT_AUTHENTICATED' as const;
  const current = yield* Effect.promise(readStore);
  if (current.kind === 'failed') return current.code;
  const owner = current.store.watches.find(
    candidate => candidate.id === watch.id && candidate.viewerId === watch.viewerId
  );
  return owner?.discoveries.some(entry => entry.id === discovery.id)
    ? undefined
    : ('WATCH_NOT_FOUND' as const);
});

/** The availability to keep: a gone item, or a Sidecar's missing children, gone when all are. */
export function learnedAvailability(
  { ref, missingChildren: known = [] }: Discovery,
  missing: readonly string[],
  slots: readonly Slot[]
): Learned | undefined {
  if (ref._tag !== 'Sidecar') {
    const [slot] = slots;
    return slot?._tag === 'gone' ? { unavailable: slot.code } : undefined;
  }
  if (missing.length === 0) return undefined;
  const missingChildren = [...known, ...missing];
  return {
    missingChildren,
    ...(missingChildren.length === ref.children.length
      ? { unavailable: 'WATCH_MEDIA_UNAVAILABLE' as const }
      : {}),
  };
}
