import {
  KindBaselinePending,
  KindChecked,
  KindOff,
  KindProblem,
  WATCH_KINDS,
  WatchSummary,
  type WatchKind,
} from '@gramgrab/protocol';
import type { Watch } from './contracts.ts';
import { watchAttention } from './attention.ts';
import { lastCheckAt } from './check.ts';
import { summarizeDiscovery } from './discoveries.ts';

/** Whether `kind` has a committed baseline, which pausing or deselecting it keeps. */
export function initialized(watch: Watch, kind: WatchKind): boolean {
  return (
    (kind === 'avatar'
      ? watch.tracking.avatar?.pictureId
      : watch.tracking[kind]?.baselineCutoff) !== undefined
  );
}

function kindHealth(watch: Watch, kind: WatchKind) {
  const tracking = watch.tracking[kind];
  if (!watch.kinds.includes(kind))
    return KindOff.make({ kind, baselineKept: initialized(watch, kind) });
  if (tracking?.problem)
    return KindProblem.make({
      kind,
      code: tracking.problem.code,
      since: tracking.problem.at,
      ...(tracking.lastSuccessAt === undefined ? {} : { lastSuccessAt: tracking.lastSuccessAt }),
    });
  if (initialized(watch, kind) && tracking?.lastSuccessAt !== undefined)
    return KindChecked.make({ kind, lastSuccessAt: tracking.lastSuccessAt });
  return KindBaselinePending.make({ kind });
}

export function summarize(watch: Watch, now = Date.now()): WatchSummary {
  const lastCheck = lastCheckAt(watch);
  return WatchSummary.make({
    watchId: watch.id,
    accountId: watch.targetId,
    username: watch.username,
    ...(watch.formerUsername ? { formerUsername: watch.formerUsername } : {}),
    enabled: watch.enabled,
    kinds: WATCH_KINDS.map(kind => kindHealth(watch, kind)),
    actions: watch.actions,
    attentionCount: watchAttention(watch).length,
    inboxCount: inbox(watch, now).length,
    createdAt: watch.createdAt,
    ...(lastCheck === undefined ? {} : { lastCheckAt: lastCheck }),
  });
}

/** The Watch's discoveries still in its inbox, newest first. */
export const inbox = (watch: Watch, now = Date.now()) =>
  discoveries(watch, now).filter(discovery => discovery.inboxUntil !== undefined);

/** Everything the Watch has found, newest first. */
export const discoveries = (watch: Watch, now = Date.now()) =>
  watch.discoveries
    .map(discovery => summarizeDiscovery(watch, discovery, now))
    .sort((left, right) => right.discoveredAt - left.discoveredAt);
