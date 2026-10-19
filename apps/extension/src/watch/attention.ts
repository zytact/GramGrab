import {
  ActionAttention,
  CheckAttention,
  WatchRecover,
  type WatchAttention,
  type ActionOutcome,
} from '@gramgrab/protocol';
import { summarizeDiscovery } from './discoveries.ts';
import { recoverable } from './recovery.ts';
import { browser } from '../lib/browser.ts';
import { ledgerOf, loginOf } from '../instagram/requests.ts';
import { readLinkedLogin } from '../instagram/linked-login.ts';
import type { Discovery, Watch, WatchStore } from './contracts.ts';
import { readStore, storeHealth } from './store.ts';
import { verifiedViewerId } from './identity.ts';

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
  const ledger = ledgerOf(await loginOf(viewerId));
  await ledger.ready();
  const paused = ledger.pausedUntil(Date.now()) ? [`pause.${viewerId}`] : [];
  const watches = store.watches.filter(watch => watch.viewerId === viewerId);
  return watches.length > 0 ? [...paused, ...watches.flatMap(watchAttention)] : [];
}

export const LINKED_ATTENTION_ID = 'linked-login';

/** `linked-login` while the linked login, signed out by Instagram, still owns Watches. */
export async function linkedAttention(store: WatchStore): Promise<string[]> {
  const linked = await readLinkedLogin();
  return linked?.ended && store.watches.some(watch => watch.viewerId === linked.accountId)
    ? [LINKED_ATTENTION_ID]
    : [];
}

/**
 * How many things need the last verified logins, as the toolbar badge and the popup show it. A
 * store that cannot be read or saved counts as one more, and so does a signed-out linked login.
 */
export async function attentionCount(): Promise<number> {
  const read = await readStore();
  if (read.kind === 'failed') return 1;
  const viewerIds = new Set(
    [await verifiedViewerId('main'), await verifiedViewerId('linked')].filter(
      (viewerId): viewerId is string => viewerId !== undefined
    )
  );
  const store = (await storeHealth()) ? 1 : 0;
  let count = store + (await linkedAttention(read.store)).length;
  for (const viewerId of viewerIds) count += (await loginAttention(read.store, viewerId)).length;
  return count;
}

export async function refreshBadge(): Promise<void> {
  const count = await attentionCount();
  await browser.action
    .setBadgeText({ text: count > 0 ? String(count) : '' })
    .catch(() => undefined);
  await browser.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => undefined);
}
