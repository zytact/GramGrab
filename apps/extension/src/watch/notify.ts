import { Effect } from 'effect';
import type { FailureCode, WatchKind } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { fetchBlobAsDataUrl } from '../effect/instagram.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import type { ChildDownload, Discovery, Watch } from './contracts.ts';
import { KIND_OF_REF } from './discoveries.ts';
import { mutateStore, readStore } from './store.ts';
import { fetchViewer } from './identity.ts';
import { PersonRequests, WatchRequests } from '../instagram/requests.ts';

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

const failureLines = (entry: Discovery, includeAttempted = false) => [
  ...(entry.download?.children.flatMap(child =>
    child.status === 'failed' && (includeAttempted || !child.notificationAttempted)
      ? [`Download: ${FAILURE_PRESENTATION[child.code].title}`]
      : []
  ) ?? []),
  ...(entry.collect &&
  'status' in entry.collect &&
  entry.collect.status === 'failed' &&
  (includeAttempted || !entry.collect.notificationAttempted)
    ? [`Collect: ${FAILURE_PRESENTATION[entry.collect.code].title}`]
    : []),
];

const notificationNeedsWork = (entry: Discovery) =>
  entry.notify?.status === 'pending' ||
  (entry.notify?.status === 'done' && failureLines(entry).length > 0);

export const notificationsNeedWork = (watch: Watch) =>
  watch.enabled && watch.discoveries.some(notificationNeedsWork);

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

const sameFailure = (
  current: { readonly code: FailureCode; readonly at: number },
  attempted: { readonly code: FailureCode; readonly at: number }
) => current.code === attempted.code && current.at === attempted.at;

const recordChild = (child: ChildDownload, attempted: ChildDownload | undefined): ChildDownload =>
  child.status === 'failed' && attempted?.status === 'failed' && sameFailure(child, attempted)
    ? { ...child, notificationAttempted: true }
    : child;

const recordCollect = (
  collect: Discovery['collect'],
  attempted: Discovery['collect']
): Discovery['collect'] =>
  collect &&
  'status' in collect &&
  collect.status === 'failed' &&
  attempted &&
  'status' in attempted &&
  attempted.status === 'failed' &&
  sameFailure(collect, attempted)
    ? { ...collect, notificationAttempted: true }
    : collect;

/** Records each entry's notify outcome; a failure stays until someone retries or dismisses it. */
const recordEntry = (
  discovery: Discovery,
  attempted: Discovery,
  code: 'WATCH_NOTIFY_PERMISSION_DENIED' | 'WATCH_NOTIFY_FAILED' | undefined,
  at: number
): Discovery => ({
  ...discovery,
  notify: code ? { status: 'failed', code, at, dismissed: false } : { status: 'done', at },
  download: discovery.download && {
    ...discovery.download,
    children: discovery.download.children.map((child, index) =>
      recordChild(child, attempted.download?.children[index])
    ),
  },
  collect: recordCollect(discovery.collect, attempted.collect),
});

const record = (
  watchId: string,
  attempted: readonly Discovery[],
  code: 'WATCH_NOTIFY_PERMISSION_DENIED' | 'WATCH_NOTIFY_FAILED' | undefined
) =>
  mutateStore(store => {
    const at = Date.now();
    const watches = store.watches.map(watch =>
      watch.id !== watchId
        ? watch
        : {
            ...watch,
            discoveries: watch.discoveries.map(discovery => {
              const snapshot = attempted.find(entry => entry.id === discovery.id);
              return snapshot ? recordEntry(discovery, snapshot, code, at) : discovery;
            }),
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
  if (!watch?.enabled) return;
  const found = watch.discoveries.filter(
    discovery => discovery.checkId === checkId && discovery.notify?.status === 'pending'
  );
  const failedActions = watch.discoveries.filter(
    entry =>
      entry.checkId === checkId && entry.notify?.status === 'done' && failureLines(entry).length > 0
  );
  const affected = [...found, ...failedActions];
  const problems = (watch.actions.includes('notify') ? watch.kinds : []).flatMap(kind => {
    const problem = watch.tracking[kind]?.problem;
    return problem && problem.at >= startedAt
      ? [`${KIND_NAME[kind]}: ${FAILURE_PRESENTATION[problem.code].title}`]
      : [];
  });
  const actionFailures = affected.flatMap(entry => failureLines(entry));
  const message = [foundLine(found), ...problems, ...new Set(actionFailures)]
    .filter(Boolean)
    .join('\n');
  if (!message) return;
  const viewer = await Effect.runPromise(
    fetchViewer.pipe(Effect.either, Effect.provide(WatchRequests))
  );
  if (viewer._tag === 'Left' || viewer.right.accountId !== watch.viewerId) return;
  const code = await show(watch, message, pictureUrl);
  if (affected.length > 0) await record(watchId, affected, code);
}

/** Sends one summary per Watch for entries whose notification is retried. */
export async function retryNotify(
  entries: readonly { readonly watchId: string; readonly entryId: string }[]
): Promise<void> {
  for (const watchId of new Set(entries.map(entry => entry.watchId))) {
    const watch = await findWatch(watchId);
    if (!watch?.enabled) continue;
    const viewer = await Effect.runPromise(
      fetchViewer.pipe(Effect.either, Effect.provide(PersonRequests))
    );
    if (viewer._tag === 'Left' || viewer.right.accountId !== watch.viewerId) continue;
    const ids = entries.filter(entry => entry.watchId === watchId).map(entry => entry.entryId);
    const chosen = watch.discoveries.filter(discovery => ids.includes(discovery.id));
    const message = [
      foundLine(chosen),
      ...new Set(chosen.flatMap(entry => failureLines(entry, true))),
    ]
      .filter(Boolean)
      .join('\n');
    if (message) await record(watchId, chosen, await show(watch, message, undefined));
  }
}

export async function resumeNotifications(watchId: string): Promise<void> {
  const watch = await findWatch(watchId);
  if (!watch?.enabled) return;
  const pending = watch.discoveries.filter(notificationNeedsWork);
  for (const checkId of new Set(pending.map(entry => entry.checkId))) {
    const firstNotification = pending.filter(
      entry => entry.checkId === checkId && entry.notify?.status === 'pending'
    );
    const startedAt =
      firstNotification.length > 0
        ? Math.min(...firstNotification.map(entry => entry.discoveredAt))
        : Date.now();
    await notifyCheck(watchId, checkId, startedAt, undefined);
  }
}

/** The Watch a GramGrab notification is about, or undefined for any other notification. */
export const notifiedWatch = (notificationId: string) =>
  notificationId.startsWith(PREFIX) ? notificationId.split('|')[1] : undefined;
