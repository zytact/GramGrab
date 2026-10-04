import { Effect, Either, Schema } from 'effect';
import { InboxExportOutcome, type FailureCode } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { ReelsMediaResponseSchema } from '../effect/schemas.ts';
import { normalizeBrowserDownloadFailure, normalizeSourceFailure } from '../errors/normalize.ts';
import { acceptedHistoryEntry } from '../history/receipt.ts';
import { appendHistory } from '../history/repository.ts';
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
type Slot =
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
    ownerId: watch.targetId,
    mediaType: ref._tag === 'Sidecar' ? 8 : ref.mediaType === 'image' ? 1 : 2,
  }).pipe(Effect.filterOrFail(items => items.length > 0, untrusted));

const storyItems = (targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const raw = yield* fetchStories(targetId);
    yield* readStories(raw, targetId, nowSeconds);
    const { data } = yield* Schema.decodeUnknown(ReelsMediaResponseSchema)(raw).pipe(
      Effect.mapError(untrusted)
    );
    return normalizeReelsMediaItems(data.reels_media);
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
const reacquire = (watch: Watch, ref: MediaRef, nowSeconds: number) =>
  Effect.gen(function* () {
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
          yield* exact(
            yield* storyItems(watch.targetId, nowSeconds),
            ref,
            'WATCH_MEDIA_UNAVAILABLE'
          ),
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
function historyOrigin(watch: Watch, ref: MediaRef): DownloadHistoryEntry['origin'] {
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

/** What one file came to. A failure may show a Sidecar child is `missing`. */
type Delivery =
  | { readonly _tag: 'accepted'; readonly historySaved: boolean }
  | { readonly _tag: 'failed'; readonly code: FailureCode; readonly missing?: string };

/**
 * Asks the browser to download one Original file and records its History receipt. Acceptance is
 * all the browser promises; it never means the file finished.
 */
async function deliver(
  watch: Watch,
  ref: MediaRef,
  item: MediaItem,
  index: number
): Promise<Delivery> {
  const filename = `${item.filenameHint}_${index + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`;
  try {
    await browser.downloads.download({ url: item.url, filename, saveAs: false });
  } catch (cause) {
    return { _tag: 'failed', code: normalizeBrowserDownloadFailure(cause).code };
  }
  const receipt = acceptedHistoryEntry(
    {
      itemIndex: index,
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      mediaType: item.type,
      filename,
      exportMode: 'direct',
    },
    historyOrigin(watch, ref)
  );
  const historySaved = await appendHistory(receipt).then(
    () => true,
    () => false
  );
  return { _tag: 'accepted', historySaved };
}

/** What exporting an entry newly showed about its availability, kept on the discovery. */
export interface Learned {
  readonly unavailable?: Unavailable;
  readonly missingChildren?: readonly string[];
}

const failed = (entryId: string, code: FailureCode) =>
  InboxExportOutcome.make({ entryId, accepted: 0, failures: [{ code }] });

const exportAuthorization = Effect.fn(function* (watch: Watch, discovery: Discovery) {
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

/** Settles one slot: a child already known missing or a gone slot fails, a found one downloads. */
function settle(watch: Watch, discovery: Discovery, slot: Slot, index: number): Promise<Delivery> {
  const { ref } = discovery;
  const child = ref._tag === 'Sidecar' ? ref.children[index] : undefined;
  if (child && discovery.missingChildren?.includes(child.mediaId))
    return Promise.resolve({ _tag: 'failed', code: 'WATCH_MEDIA_UNAVAILABLE' });
  if (slot._tag === 'gone')
    return Promise.resolve({
      _tag: 'failed',
      code: slot.code,
      ...(child ? { missing: child.mediaId } : {}),
    });
  return deliver(watch, ref, slot.item, index);
}

/**
 * Exports one inbox entry's exact media as Original. An entry already known to be gone fails with
 * its reason and no request, and so does a recorded missing Sidecar child.
 */
export const exportEntry = (watch: Watch, discovery: Discovery) =>
  Effect.gen(function* () {
    const { id: entryId, ref } = discovery;
    if (discovery.unavailable) return { outcome: failed(entryId, discovery.unavailable) };
    const slots = yield* Effect.either(reacquire(watch, ref, Math.floor(Date.now() / 1000)));
    if (Either.isLeft(slots))
      return {
        outcome: failed(
          entryId,
          slots.left._tag === 'WatchRequestDeferred'
            ? 'SOURCE_UNEXPECTED_FAILURE'
            : normalizeSourceFailure(slots.left).code
        ),
      };
    const settled = yield* Effect.forEach(slots.right, (slot, index) =>
      Effect.gen(function* () {
        if (slot._tag === 'found') {
          const code = yield* exportAuthorization(watch, discovery);
          if (code) return { _tag: 'failed', code } satisfies Delivery;
        }
        return yield* Effect.promise(() => settle(watch, discovery, slot, index));
      })
    );
    const accepted = settled.filter(delivery => delivery._tag === 'accepted');
    const failures = settled.flatMap((delivery, index) =>
      delivery._tag === 'failed' ? [{ index, ...delivery }] : []
    );
    return {
      outcome: InboxExportOutcome.make({
        entryId,
        accepted: accepted.length,
        failures: failures.map(({ index, code }) =>
          ref._tag === 'Sidecar' ? { child: index, code } : { code }
        ),
        ...(accepted.every(delivery => delivery.historySaved)
          ? {}
          : { warning: 'HISTORY_SAVE_FAILED' as const }),
      }),
      learned: learned(
        discovery,
        failures.flatMap(({ missing }) => (missing ? [missing] : [])),
        slots.right
      ),
    };
  });

/** The availability to keep: a gone item, or a Sidecar's missing children, gone when all are. */
function learned(
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
