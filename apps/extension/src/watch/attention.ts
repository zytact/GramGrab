import { Schema } from 'effect';
import { AccountId } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import type { Watch, WatchStore } from './contracts.ts';
import { readStore, storeHealth } from './store.ts';

/** The login whose Watches the badge counts, kept only for this browser session. */
const VIEWER_KEY = 'watch-viewer';

/**
 * Stable IDs of what needs the person, for one Watch. A check problem is
 * `check.<watchId>.<kind>`; it clears only when that kind checks successfully again.
 */
export function watchAttention(watch: Watch): string[] {
  if (!watch.enabled) return [];
  return watch.kinds.flatMap(kind =>
    watch.tracking[kind]?.problem ? [`check.${watch.id}.${kind}`] : []
  );
}

/** Everything that needs the given login, across its Watches. */
export const loginAttention = (store: WatchStore, viewerId: string): string[] =>
  store.watches.filter(watch => watch.viewerId === viewerId).flatMap(watchAttention);

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
  return store + (viewerId ? loginAttention(read.store, viewerId).length : 0);
}

export async function refreshBadge(): Promise<void> {
  const count = await attentionCount();
  await browser.action
    .setBadgeText({ text: count > 0 ? String(count) : '' })
    .catch(() => undefined);
  await browser.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => undefined);
}
