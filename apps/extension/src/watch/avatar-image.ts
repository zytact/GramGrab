import { Effect, Either, Schema } from 'effect';
import type { KindCheckOutcome } from '@gramgrab/protocol';
import { WatchRequests } from '../instagram/requests.ts';
import type { WatchAvatarsResponse } from '../messaging/contracts.ts';
import { AvatarJpeg, type AvatarImage, type Watch } from './contracts.ts';
import { fetchAvatar, readAvatar } from './avatar.ts';
import { mutateStore, readStore } from './store.ts';

/** The square side pictures are cropped and scaled to: twice the largest size the page shows. */
const SIDE = 80;
/** A Watch that does not track Avatar changes looks its picture up again after this long. */
const LOOKUP_AFTER_MS = 7 * 24 * 60 * 60_000;

/** What a check saw of the account's current picture. */
export interface ObservedAvatar {
  readonly pictureId: string;
  readonly pictureUrl?: string;
}

const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

/** Loads a picture from the CDN and center-crops it to a small JPEG, or undefined if that fails. */
async function loadJpeg(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return undefined;
    const bitmap = await createImageBitmap(await response.blob());
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(SIDE, SIDE);
    canvas
      .getContext('2d')
      ?.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        SIDE,
        SIDE
      );
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const jpeg = base64(new Uint8Array(await blob.arrayBuffer()));
    return Schema.is(AvatarJpeg)(jpeg) ? jpeg : undefined;
  } catch {
    return undefined;
  }
}

const dataUrl = (jpeg: string) => `data:image/jpeg;base64,${jpeg}`;

/** Looks up the account's current picture by its stored username, matched by account ID. */
const lookup = (watch: Watch) =>
  Effect.runPromise(
    fetchAvatar(watch.username).pipe(
      Effect.flatMap(raw => readAvatar(raw, watch.targetId, watch.username)),
      Effect.provide(WatchRequests),
      Effect.either,
      Effect.map(Either.getOrUndefined)
    )
  );

const saveImage = (watchId: string, image: AvatarImage) =>
  mutateStore(store => {
    if (!store.watches.some(watch => watch.id === watchId)) return { store, value: undefined };
    return {
      store: {
        ...store,
        watches: store.watches.map(watch =>
          watch.id === watchId ? { ...watch, avatarImage: image } : watch
        ),
      },
      value: undefined,
    };
  });

const reachedInstagram = (outcome: KindCheckOutcome) =>
  outcome._tag === 'KindCheckSucceeded' || outcome._tag === 'KindBaselineRecorded';

/**
 * Keeps a Watch's cached picture current after a check that reached Instagram. The picture is
 * loaded again only when its identity changes. A check of Avatar changes supplies the identity;
 * any other Watch looks it up when it has no picture yet or the last lookup is a week old.
 */
export async function refreshAvatarImage(
  watchId: string,
  viewerId: string,
  run: { readonly kinds: readonly KindCheckOutcome[]; readonly avatar?: ObservedAvatar }
): Promise<void> {
  if (!run.kinds.some(reachedInstagram)) return;
  const read = await readStore();
  const watch =
    read.kind === 'ok'
      ? read.store.watches.find(item => item.id === watchId && item.viewerId === viewerId)
      : undefined;
  if (!watch?.enabled) return;
  const now = Date.now();
  const cached = watch.avatarImage;
  const due =
    !run.avatar &&
    !watch.kinds.includes('avatar') &&
    (!cached || now - cached.checkedAt >= LOOKUP_AFTER_MS);
  const observed = run.avatar ?? (due ? await lookup(watch) : undefined);
  if (!observed) return;
  if (cached?.pictureId === observed.pictureId) {
    if (!run.avatar) await saveImage(watchId, { ...cached, checkedAt: now });
    return;
  }
  const jpeg = observed.pictureUrl && (await loadJpeg(observed.pictureUrl));
  if (jpeg) await saveImage(watchId, { pictureId: observed.pictureId, jpeg, checkedAt: now });
}

/**
 * The verified login's picture, held in worker memory only. The viewer query that verifies the
 * login carries its URL, so showing it costs no Instagram request.
 */
let viewerPicture:
  | { readonly accountId: string; readonly url: string; jpeg?: Promise<string | undefined> }
  | undefined;

export function noteViewerPicture(viewer: { accountId: string; pictureUrl?: string }): void {
  if (viewerPicture?.accountId === viewer.accountId && viewerPicture.url === viewer.pictureUrl)
    return;
  viewerPicture = viewer.pictureUrl
    ? { accountId: viewer.accountId, url: viewer.pictureUrl }
    : undefined;
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
  const picture = viewerPicture?.accountId === viewerId ? viewerPicture : undefined;
  const login = picture && (await (picture.jpeg ??= loadJpeg(picture.url)));
  if (picture && !login) picture.jpeg = undefined;
  return login ? { login: dataUrl(login), watches } : { watches };
}
