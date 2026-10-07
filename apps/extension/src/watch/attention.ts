import { Schema } from 'effect';
import {
  ActionAttention,
  CheckAttention,
  WatchRecover,
  WatchViewer,
  type WatchAttention,
  type ActionOutcome,
} from '@gramgrab/protocol';
import { summarizeDiscovery } from './discoveries.ts';
import { recoverable } from './recovery.ts';
import { browser } from '../lib/browser.ts';
import { requestLedger } from '../instagram/requests.ts';
import type { Discovery, Watch, WatchStore } from './contracts.ts';
import { readStore, storeHealth } from './store.ts';

/**
 * The login the last viewer verification found, kept only for this browser session. The badge
 * counts its Watches, and the options page's reads reuse it instead of asking Instagram again.
 */
const VIEWER_KEY = 'watch-viewer';

/**
 * Stable IDs of what needs the person, for one Watch. A check problem is
 * `check.<watchId>.<kind>` and clears only when that kind checks successfully again; it is held
 * back while the Watch is paused. A failed action is `action.<action>.<entryId>` with a child index for downloads until it is retried or
 * dismissed.
 */
export function watchAttention(watch: Watch): string[] {
  return watchAttentionItems(watch).map(item => item.attentionId);
}

export function watchAttentionItems(watch: Watch): WatchAttention[] {
  const checks = watch.enabled
    ? watch.kinds.flatMap(kind => {
        const tracking = watch.tracking[kind];
        const problem = tracking?.problem;
        return problem
          ? [
              CheckAttention.make({
                attentionId: `check.${watch.id}.${kind}`,
                watchId: watch.id,
                kind,
                code: problem.code,
                since: problem.at,
                ...(tracking.lastSuccessAt === undefined
                  ? {}
                  : { lastSuccessAt: tracking.lastSuccessAt }),
              }),
            ]
          : [];
      })
    : [];
  return [...checks, ...watch.discoveries.flatMap(entry => actionAttention(watch, entry))];
}

function attentionAction(
  watch: Watch,
  entry: Discovery,
  action: ActionAttention['action'],
  outcome: ActionOutcome | undefined,
  child?: number
): ActionAttention[] {
  if (
    !outcome ||
    outcome.dismissed ||
    (outcome.state !== 'failed' && outcome.state !== 'unconfirmed')
  )
    return [];
  const attentionId =
    outcome.state === 'unconfirmed'
      ? `uncertain.${entry.id}.${child}`
      : `action.${action}.${entry.id}${child === undefined ? '' : `.${child}`}`;
  const operations = (['retry', 'dismiss', 'confirm'] as const).filter(
    operation =>
      watch.enabled &&
      recoverable(
        entry,
        WatchRecover.make({
          action,
          operation,
          entryIds: [entry.id],
          ...(child === undefined ? {} : { child }),
        })
      )
  );
  return [
    ActionAttention.make({
      attentionId,
      entryId: entry.id,
      action,
      state: outcome.state,
      operations,
      ...(outcome.code ? { code: outcome.code } : {}),
      ...(child === undefined ? {} : { child }),
    }),
  ];
}

function actionAttention(watch: Watch, entry: Discovery): ActionAttention[] {
  const summary = summarizeDiscovery(watch, entry, Date.now());
  return [
    ...attentionAction(watch, entry, 'notify', summary.notify),
    ...attentionAction(watch, entry, 'collect', summary.collect),
    ...(entry.download?.dismissed
      ? []
      : (summary.downloadChildren?.flatMap((outcome, index) =>
          attentionAction(watch, entry, 'download', outcome, index)
        ) ?? [])),
  ];
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

export async function rememberViewer(viewer: WatchViewer): Promise<void> {
  await browser.sessionStorage
    .set({ [VIEWER_KEY]: Schema.encodeSync(WatchViewer)(viewer) })
    .catch(() => undefined);
}

export async function forgetViewer(): Promise<void> {
  await browser.sessionStorage.remove(VIEWER_KEY).catch(() => undefined);
}

export async function rememberedViewer(): Promise<WatchViewer | undefined> {
  const stored = await browser.sessionStorage
    .get(VIEWER_KEY)
    .catch((): Record<string, unknown> => ({}));
  const decoded = Schema.decodeUnknownOption(WatchViewer)(stored[VIEWER_KEY]);
  return decoded._tag === 'Some' ? decoded.value : undefined;
}

/**
 * How many things need the last verified login, as the toolbar badge and the popup show it. A
 * store that cannot be read or saved counts as one more.
 */
export async function attentionCount(): Promise<number> {
  const read = await readStore();
  if (read.kind === 'failed') return 1;
  const viewer = await rememberedViewer();
  const store = (await storeHealth()) ? 1 : 0;
  return store + (viewer ? (await loginAttention(read.store, viewer.accountId)).length : 0);
}

export async function refreshBadge(): Promise<void> {
  const count = await attentionCount();
  await browser.action
    .setBadgeText({ text: count > 0 ? String(count) : '' })
    .catch(() => undefined);
  await browser.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => undefined);
}
