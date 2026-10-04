import { Schema } from 'effect';
import { AccountId } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { requestLedger } from '../instagram/requests.ts';
import type { Discovery, Watch, WatchStore } from './contracts.ts';
import { readStore, storeHealth } from './store.ts';

/** The login whose Watches the badge counts, kept only for this browser session. */
const VIEWER_KEY = 'watch-viewer';

/**
 * Stable IDs of what needs the person, for one Watch. A check problem is
 * `check.<watchId>.<kind>` and clears only when that kind checks successfully again; it is held
 * back while the Watch is paused. A failed action is `action.<action>.<entryId>` with a child index for downloads until it is retried or
 * dismissed.
 */
export function watchAttention(watch: Watch): string[] {
  const checks = watch.enabled
    ? watch.kinds.flatMap(kind =>
        watch.tracking[kind]?.problem ? [`check.${watch.id}.${kind}`] : []
      )
    : [];
  const actions = watch.discoveries.flatMap(entry => [
    ...notificationAttention(entry),
    ...collectionAttention(entry),
    ...downloadAttention(entry),
  ]);
  return [...checks, ...actions];
}

function notificationAttention(entry: Discovery): string[] {
  return entry.notify?.status === 'failed' && !entry.notify.dismissed
    ? [`action.notify.${entry.id}`]
    : [];
}

function collectionAttention(entry: Discovery): string[] {
  const collect = entry.collect;
  return collect && 'status' in collect && collect.status === 'failed' && !collect.dismissed
    ? [`action.collect.${entry.id}`]
    : [];
}

function downloadAttention(entry: Discovery): string[] {
  if (!entry.download || entry.download.dismissed) return [];
  return entry.download.children.flatMap((child, index) => {
    if (child.status === 'uncertain') return [`uncertain.${entry.id}.${index}`];
    return child.status === 'failed' && !child.dismissed
      ? [`action.download.${entry.id}.${index}`]
      : [];
  });
}

/**
 * Everything that needs the given login, across its Watches. A rate-limit pause is one item,
 * `pause.<viewerId>`, however many Watches it holds back.
 */
export async function loginAttention(store: WatchStore, viewerId: string): Promise<string[]> {
  await requestLedger.ready();
  const paused = requestLedger.pausedUntil(Date.now()) ? [`pause.${viewerId}`] : [];
  const watches = store.watches.filter(watch => watch.viewerId === viewerId);
  return watches.length > 0 ? [...paused, ...watches.flatMap(watchAttention)] : [];
}

export async function rememberViewer(viewerId: string): Promise<void> {
  await browser.sessionStorage.set({ [VIEWER_KEY]: viewerId }).catch(() => undefined);
}

async function rememberedViewer(): Promise<string | undefined> {
  const stored = await browser.sessionStorage
    .get(VIEWER_KEY)
    .catch((): Record<string, unknown> => ({}));
  const decoded = Schema.decodeUnknownOption(AccountId)(stored[VIEWER_KEY]);
  return decoded._tag === 'Some' ? decoded.value : undefined;
}

/**
 * How many things need the last verified login, as the toolbar badge and the popup show it. A
 * store that cannot be read or saved counts as one more.
 */
export async function attentionCount(): Promise<number> {
  const read = await readStore();
  if (read.kind === 'failed') return 1;
  const viewerId = await rememberedViewer();
  const store = (await storeHealth()) ? 1 : 0;
  return store + (viewerId ? (await loginAttention(read.store, viewerId)).length : 0);
}

export async function refreshBadge(): Promise<void> {
  const count = await attentionCount();
  await browser.action
    .setBadgeText({ text: count > 0 ? String(count) : '' })
    .catch(() => undefined);
  await browser.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => undefined);
}
