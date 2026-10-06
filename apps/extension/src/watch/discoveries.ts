import { Schema } from 'effect';
import {
  ActionOutcome,
  DiscoverySummary,
  KindBaselineRecorded,
  KindCheckSucceeded,
  type FailureCode,
  type KindCheckOutcome,
  type WatchKind,
} from '@gramgrab/protocol';
import {
  RETENTION_MS,
  type ChildDownload,
  type Discovery,
  type MediaRef,
  type TimedRef,
  type TimedTracking,
  type Watch,
} from './contracts.ts';

const decodeUuid = Schema.decodeUnknownSync(Schema.UUID);
const SECOND_MS = 1000;

const KIND_OF_REF = {
  Post: 'posts',
  Sidecar: 'posts',
  Story: 'stories',
  Instant: 'instants',
  Avatar: 'avatar',
} as const satisfies Record<MediaRef['_tag'], WatchKind>;

/** The identity that makes a reference "seen": a media ID, or an Avatar's picture ID. */
const refIdentity = (ref: MediaRef): string =>
  ref._tag === 'Avatar' ? ref.pictureId : ref.mediaId;

type TimedKind = Exclude<WatchKind, 'avatar'>;

/** Records a discovery with every selected action waiting, and collection done with it. */
function discover(ref: MediaRef, watch: Watch, checkId: string, now: number): Discovery {
  const files = ref._tag === 'Sidecar' ? ref.children.length : 1;
  const pending: ChildDownload = { status: 'pending' };
  return {
    id: decodeUuid(crypto.randomUUID()),
    checkId: decodeUuid(checkId),
    ref,
    discoveredAt: now,
    ...(watch.actions.includes('notify') ? { notify: { status: 'pending' } } : {}),
    ...(watch.actions.includes('download')
      ? { download: { children: Array.from({ length: files }, () => pending), dismissed: false } }
      : {}),
    ...(watch.actions.includes('collect') ? { collect: { at: now } } : {}),
  };
}

/** Whether a discovery still has an action someone must finish, retry, confirm, or dismiss. */
function unresolved(discovery: Discovery): boolean {
  const notify = discovery.notify;
  if (notify?.status === 'pending' || (notify?.status === 'failed' && !notify.dismissed))
    return true;
  const download = discovery.download;
  if (!download) return false;
  return download.children.some(
    child =>
      child.status === 'pending' ||
      child.status === 'starting' ||
      child.status === 'uncertain' ||
      (child.status === 'failed' && !download.dismissed)
  );
}

/**
 * Drops discoveries older than the 30-day window once nothing about them is left to finish. A
 * discovery is at least as old as its media, so its media has left the eligibility window too.
 */
const prune = (discoveries: readonly Discovery[], now: number): Discovery[] =>
  discoveries.filter(
    discovery => now - discovery.discoveredAt < RETENTION_MS || unresolved(discovery)
  );

/** The oldest publication second a discovery may have: inside the 30-day window. */
export const windowStartAt = (now: number) => Math.floor((now - RETENTION_MS) / SECOND_MS);

/** Whether media published at `takenAt` is new: after the cutoff and inside the window. */
export const eligible = (takenAt: number, cutoff: number, windowStart: number) =>
  takenAt > cutoff && takenAt >= windowStart;

/**
 * Records every unseen eligible reference as a discovery of `checkId`, pruning what has aged out.
 * Tracking is left to the caller.
 */
export function discoverNew(
  watch: Watch,
  refs: readonly TimedRef[],
  context: {
    readonly checkId: string;
    readonly cutoff: number;
    readonly windowStart: number;
    readonly now: number;
  }
): { readonly watch: Watch; readonly newCount: number } {
  const { checkId, cutoff, windowStart, now } = context;
  const seen = new Set(watch.discoveries.map(discovery => refIdentity(discovery.ref)));
  const found: Discovery[] = [];
  for (const ref of refs) {
    if (!eligible(ref.takenAt, cutoff, windowStart) || seen.has(ref.mediaId)) continue;
    seen.add(ref.mediaId);
    found.push(discover(ref, watch, checkId, now));
  }
  return {
    watch: { ...watch, discoveries: prune([...watch.discoveries, ...found], now) },
    newCount: found.length,
  };
}

/**
 * Applies one timed kind's trustworthy acquisition. The first one only records the baseline
 * cutoff frozen when its request started; later ones discover unseen media published after that
 * cutoff and within the last 30 days.
 */
export function applyTimedCheck(
  watch: Watch,
  kind: TimedKind,
  refs: readonly TimedRef[],
  context: { readonly checkId: string; readonly proposedCutoff: number; readonly now: number }
): { readonly watch: Watch; readonly outcome: KindCheckOutcome } {
  const { checkId, proposedCutoff, now } = context;
  const baseline = watch.tracking[kind]?.baselineCutoff;
  const cutoff = baseline ?? proposedCutoff;
  const checked: TimedTracking = { baselineCutoff: cutoff, lastSuccessAt: now, lastCheckAt: now };
  const tracked = { ...watch, tracking: { ...watch.tracking, [kind]: checked } };
  if (baseline === undefined)
    return { watch: tracked, outcome: KindBaselineRecorded.make({ kind }) };
  const result = discoverNew(tracked, refs, {
    checkId,
    cutoff,
    windowStart: windowStartAt(now),
    now,
  });
  return {
    watch: result.watch,
    outcome: KindCheckSucceeded.make({ kind, newCount: result.newCount, catchUp: false }),
  };
}

/** Records a kind's failed check, keeping its baseline, last success, and the problem's start. */
export function applyKindProblem(
  watch: Watch,
  kind: WatchKind,
  code: FailureCode,
  now: number
): Watch {
  const tracking = watch.tracking[kind] ?? {};
  const since = tracking.problem?.code === code ? tracking.problem.at : now;
  return {
    ...watch,
    tracking: {
      ...watch.tracking,
      [kind]: { ...tracking, lastCheckAt: now, problem: { code, at: since } },
    },
  };
}

function downloadOutcome(discovery: Discovery): ActionOutcome | undefined {
  const children = discovery.download?.children;
  if (!children) return undefined;
  if (children.some(child => child.status === 'uncertain'))
    return ActionOutcome.make({ state: 'unconfirmed' });
  const failed = children.find(child => child.status === 'failed');
  if (failed?.status === 'failed')
    return ActionOutcome.make({ state: 'failed', code: failed.code });
  return ActionOutcome.make({
    state: children.every(child => child.status === 'accepted' || child.status === 'confirmed')
      ? 'done'
      : 'waiting',
  });
}

const NOTIFY_STATE = { pending: 'waiting', done: 'done', failed: 'failed' } as const;

/** Presents a discovery without its media references. */
export function summarizeDiscovery(
  watch: Watch,
  discovery: Discovery,
  now: number
): DiscoverySummary {
  const { ref } = discovery;
  const inboxUntil = discovery.discoveredAt + RETENTION_MS;
  const inInbox =
    discovery.collect && discovery.collect.removedAt === undefined && inboxUntil > now;
  const download = downloadOutcome(discovery);
  return DiscoverySummary.make({
    entryId: discovery.id,
    watchId: watch.id,
    accountId: watch.targetId,
    username: watch.username,
    kind: KIND_OF_REF[ref._tag],
    mediaType:
      ref._tag === 'Sidecar' ? 'sidecar' : ref._tag === 'Avatar' ? 'avatar' : ref.mediaType,
    ...(ref._tag === 'Sidecar' ? { childCount: ref.children.length } : {}),
    discoveredAt: discovery.discoveredAt,
    ...(inInbox ? { inboxUntil } : {}),
    ...(discovery.unavailable ? { unavailable: discovery.unavailable } : {}),
    ...(discovery.missingChildren ? { missingChildren: discovery.missingChildren.length } : {}),
    ...(discovery.notify
      ? { notify: ActionOutcome.make({ state: NOTIFY_STATE[discovery.notify.status] }) }
      : {}),
    ...(download ? { download } : {}),
    ...(discovery.collect ? { collect: ActionOutcome.make({ state: 'done' }) } : {}),
  });
}
