import { Effect } from 'effect';
import type { WatchKind } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { fetchBlobAsDataUrl } from '../effect/instagram.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import type { Discovery, Watch } from './contracts.ts';
import { KIND_OF_REF } from './discoveries.ts';
import { mutateStore, readStore } from './store.ts';

const PREFIX = 'watch|';

const NOUNS: Record<WatchKind, readonly [string, string]> = {
  posts: ['new Post', 'new Posts'],
  stories: ['new Story', 'new Stories'],
  instants: ['new Instant', 'new Instants'],
  avatar: ['Avatar change', 'Avatar changes'],
};

const KIND_NAME: Record<WatchKind, string> = {
  posts: 'Posts',
  stories: 'Stories',
  instants: 'Instants',
  avatar: 'Avatar',
};

/** "2 new Posts, 1 Avatar change", in the order the kinds are checked. */
function foundLine(discoveries: readonly Discovery[]): string | undefined {
  const counts = new Map<WatchKind, number>();
  for (const { ref } of discoveries)
    counts.set(KIND_OF_REF[ref._tag], (counts.get(KIND_OF_REF[ref._tag]) ?? 0) + 1);
  const parts = (['stories', 'instants', 'avatar', 'posts'] as const).flatMap(kind => {
    const count = counts.get(kind);
    return count ? [`${count} ${NOUNS[kind][count === 1 ? 0 : 1]}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** The account's current Avatar as a data URL, or GramGrab's icon when it will not load. */
const iconFor = (pictureUrl: string | undefined) =>
  pictureUrl
    ? Effect.runPromise(fetchBlobAsDataUrl(pictureUrl).pipe(Effect.orElseSucceed(() => undefined)))
    : Promise.resolve(undefined);

/**
 * Shows one notification and reports how it went. An Avatar icon that the browser refuses is
 * dropped for GramGrab's own icon rather than costing the notification.
 */
async function show(
  watch: Watch,
  message: string,
  pictureUrl: string | undefined
): Promise<'WATCH_NOTIFY_PERMISSION_DENIED' | 'WATCH_NOTIFY_FAILED' | undefined> {
  const allowed = await browser.permissions
    .contains({ permissions: ['notifications'] })
    .catch(() => false);
  if (!allowed) return 'WATCH_NOTIFY_PERMISSION_DENIED';
  const id = `${PREFIX}${watch.id}|${crypto.randomUUID()}`;
  const packaged = browser.runtime.getURL('icons/icon-96.png');
  const options = { type: 'basic' as const, title: `@${watch.username}`, message };
  const icon = await iconFor(pictureUrl);
  try {
    await browser.notifications.create(id, { ...options, iconUrl: icon ?? packaged });
    return undefined;
  } catch {
    if (!icon) return 'WATCH_NOTIFY_FAILED';
    return browser.notifications
      .create(id, { ...options, iconUrl: packaged })
      .then(() => undefined)
      .catch(() => 'WATCH_NOTIFY_FAILED' as const);
  }
}

/** Records each entry's notify outcome; a failure stays until someone retries or dismisses it. */
const record = (
  watchId: string,
  entryIds: readonly string[],
  code: 'WATCH_NOTIFY_PERMISSION_DENIED' | 'WATCH_NOTIFY_FAILED' | undefined
) =>
  mutateStore(store => {
    const at = Date.now();
    const watches = store.watches.map(watch =>
      watch.id !== watchId
        ? watch
        : {
            ...watch,
            discoveries: watch.discoveries.map(discovery =>
              entryIds.includes(discovery.id)
                ? {
                    ...discovery,
                    notify: code
                      ? { status: 'failed' as const, code, at, dismissed: false }
                      : { status: 'done' as const, at },
                  }
                : discovery
            ),
          }
    );
    return { store: { ...store, watches }, value: undefined };
  });

const findWatch = async (watchId: string) => {
  const read = await readStore();
  return read.kind === 'ok' ? read.store.watches.find(watch => watch.id === watchId) : undefined;
};

/**
 * After a check of a Watch that notifies: one summary of what the check found, and of kinds whose
 * problem started during it. A problem that was already there is not announced again.
 */
export async function notifyCheck(
  watchId: string,
  checkId: string,
  startedAt: number,
  pictureUrl: string | undefined
): Promise<void> {
  const watch = await findWatch(watchId);
  if (!watch?.actions.includes('notify')) return;
  const found = watch.discoveries.filter(
    discovery => discovery.checkId === checkId && discovery.notify?.status === 'pending'
  );
  const problems = watch.kinds.flatMap(kind => {
    const problem = watch.tracking[kind]?.problem;
    return problem && problem.at >= startedAt
      ? [`${KIND_NAME[kind]}: ${FAILURE_PRESENTATION[problem.code].title}`]
      : [];
  });
  const message = [foundLine(found), ...problems].filter(Boolean).join('\n');
  if (!message) return;
  const code = await show(watch, message, pictureUrl);
  if (found.length > 0)
    await record(
      watchId,
      found.map(discovery => discovery.id),
      code
    );
}

/** Sends one summary per Watch for entries whose notification is retried. */
export async function retryNotify(
  entries: readonly { readonly watchId: string; readonly entryId: string }[]
): Promise<void> {
  for (const watchId of new Set(entries.map(entry => entry.watchId))) {
    const watch = await findWatch(watchId);
    if (!watch) continue;
    const ids = entries.filter(entry => entry.watchId === watchId).map(entry => entry.entryId);
    const line = foundLine(watch.discoveries.filter(discovery => ids.includes(discovery.id)));
    if (line) await record(watchId, ids, await show(watch, line, undefined));
  }
}

/** The Watch a GramGrab notification is about, or undefined for any other notification. */
export const notifiedWatch = (notificationId: string) =>
  notificationId.startsWith(PREFIX) ? notificationId.split('|')[1] : undefined;
