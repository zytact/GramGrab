import { Effect, Either } from 'effect';
import type { KindCheckOutcome } from '@gramgrab/protocol';
import { WatchRequests } from '../instagram/requests.ts';
import type { WatchAvatarsResponse } from '../messaging/contracts.ts';
import type { Watch } from './contracts.ts';
import { fetchAvatar, readAvatar, type ObservedAvatar } from './avatar.ts';
import { mutateStore, readStore, withinStoreBudget } from './store.ts';
import { loadJpeg, dataUrl } from './avatar-jpeg.ts';
import { viewerJpeg } from './viewer-avatar.ts';
import { checkNeedsLogin } from './check.ts';

/** A Watch that does not track Avatar changes looks its picture up again after this long. */
const LOOKUP_AFTER_MS = 7 * 24 * 60 * 60_000;

/** Looks up the account's current picture by its stored username, matched by account ID. */
const lookup = (watch: Watch) =>
  Effect.runPromise(
    fetchAvatar(watch.username).pipe(
      Effect.flatMap(raw => readAvatar(raw, watch.targetId, watch.username)),
      Effect.provide(WatchRequests),
      Effect.either
    )
  );

const saveImage = (watchId: string, change: Pick<Watch, 'avatarImage' | 'avatarLookupAt'>) =>
  mutateStore(store => {
    if (!store.watches.some(watch => watch.id === watchId)) return { store, value: false };
    const next = {
      ...store,
      watches: store.watches.map(watch => (watch.id === watchId ? { ...watch, ...change } : watch)),
    };
    const fits = withinStoreBudget(next);
    return { store: fits ? next : store, value: fits };
  });

const reachedInstagram = (outcome: KindCheckOutcome) =>
  outcome._tag === 'KindCheckSucceeded' || outcome._tag === 'KindBaselineRecorded';

const lookupDue = (watch: Watch, now: number) =>
  (!watch.kinds.includes('avatar') || !watch.avatarImage) &&
  now - (watch.avatarLookupAt ?? watch.avatarImage?.checkedAt ?? 0) >= LOOKUP_AFTER_MS;

async function loadImage(watch: Watch, observed: ObservedAvatar | undefined, now: number) {
  if (observed?.pictureId === watch.avatarImage?.pictureId) return watch.avatarImage;
  const jpeg = observed?.pictureUrl && (await loadJpeg(observed.pictureUrl));
  return observed && jpeg ? { pictureId: observed.pictureId, jpeg, checkedAt: now } : undefined;
}

async function cacheImage(
  watch: Watch,
  observed: ObservedAvatar | undefined,
  now: number
): Promise<void> {
  const unchanged = observed && observed.pictureId === watch.avatarImage?.pictureId;
  if (unchanged) return;
  const image = await loadImage(watch, observed, now);
  if (image) await saveImage(watch.id, { avatarImage: image });
}

/**
 * Keeps a Watch's cached picture current after a check that reached Instagram. The picture is
 * loaded again only when its identity changes. A check of Avatar changes supplies the identity;
 * any other Watch looks it up at most once a week, including failed attempts. An omitted Avatar
 * step can use the same lookup for an initial image, without repeating a failed Avatar step.
 */
export async function refreshAvatarImage(
  watchId: string,
  viewerId: string,
  run: {
    readonly kinds: readonly KindCheckOutcome[];
    readonly avatar?: ObservedAvatar;
    readonly avatarAttempted: boolean;
  }
): Promise<void> {
  if (!run.kinds.some(reachedInstagram) || checkNeedsLogin(run.kinds)) return;
  const read = await readStore();
  const watch =
    read.kind === 'ok'
      ? read.store.watches.find(item => item.id === watchId && item.viewerId === viewerId)
      : undefined;
  if (!watch?.enabled) return;
  const now = Date.now();
  const due = !run.avatar && !run.avatarAttempted && lookupDue(watch, now);
  let observed = run.avatar;
  if (due) {
    const booked = await saveImage(watch.id, { avatarLookupAt: now });
    if (booked.kind !== 'ok' || !booked.value) return;
    const result = await lookup(watch);
    if (Either.isLeft(result) && result.left._tag === 'WatchRequestDeferred') {
      await saveImage(watch.id, { avatarLookupAt: watch.avatarLookupAt });
      return;
    }
    observed = Either.getOrUndefined(result);
  }
  await cacheImage(watch, observed, now);
}

/** The pictures the Watches page shows for `viewerId`: its own, and each of its Watches'. */
export async function watchAvatars(viewerId: string): Promise<WatchAvatarsResponse> {
  const read = await readStore();
  const watches = Object.fromEntries(
    (read.kind === 'ok' ? read.store.watches : []).flatMap(watch =>
      watch.viewerId === viewerId && watch.avatarImage
        ? [[watch.id, dataUrl(watch.avatarImage.jpeg)]]
        : []
    )
  );
  const login = await viewerJpeg(viewerId);
  return login ? { login: dataUrl(login), watches } : { watches };
}
