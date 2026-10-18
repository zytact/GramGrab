import { Effect } from 'effect';
import type { FetchedMedia } from './contracts.ts';
import { markFetched } from './discoveries.ts';
import { fetchViewer } from './identity.ts';
import { mutateStore, readStore } from './store.ts';

/**
 * Marks media the person fetched as seen by the verified login's Watches of its owners. It asks
 * for the viewer only when such a Watch exists, and never fails the fetch it follows.
 */
export const recordFetched = (fetched: readonly FetchedMedia[]) =>
  Effect.gen(function* () {
    const owners = new Set(fetched.flatMap(media => media.owners));
    const read = yield* Effect.promise(readStore);
    if (read.kind !== 'ok' || !read.store.watches.some(watch => owners.has(watch.targetId))) return;
    const viewer = yield* fetchViewer;
    yield* Effect.promise(() =>
      mutateStore(store => {
        const now = Date.now();
        const watches = store.watches.map(watch =>
          watch.viewerId === viewer.accountId ? markFetched(watch, fetched, now) : watch
        );
        const changed = watches.some((watch, index) => watch !== store.watches[index]);
        return { store: changed ? { ...store, watches } : store, value: undefined };
      })
    );
  }).pipe(Effect.catchAll(() => Effect.void));
