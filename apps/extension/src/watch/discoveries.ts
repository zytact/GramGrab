import { planOutcome } from './manual-export.ts';
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

export const KIND_OF_REF = {
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
    ...(watch.actions.includes('collect') ? { collect: { status: 'pending' } } : {}),
  };
}

/** Whether a discovery has a failed action the person has not retried or dismissed. */
export const needsPerson = (discovery: Discovery) =>
  (discovery.notify?.status === 'failed' && !discovery.notify.dismissed) ||
  (discovery.collect &&
    'status' in discovery.collect &&
    discovery.collect.status === 'failed' &&
    !discovery.collect.dismissed) ||
  (discovery.download &&
    !discovery.download.dismissed &&
    discovery.download.children.some(
      child => (child.status === 'failed' && !child.dismissed) || child.status === 'uncertain'
    ));

/** Whether a discovery still has an action someone must finish, retry, confirm, or dismiss. */
const collectUnresolved = (collect: Discovery['collect']) =>
  collect !== undefined &&
  'status' in collect &&
  (collect.status === 'pending' || !collect.dismissed);
const downloadUnresolved = (download: Discovery['download']) =>
  download?.children.some(
    child =>
      child.status === 'pending' ||
      child.status === 'starting' ||
      child.status === 'uncertain' ||
      (child.status === 'failed' && !child.dismissed && !download.dismissed)
  );

function unresolved(discovery: Discovery): boolean {
  const notify = discovery.notify;
  if (notify?.status === 'pending' || (notify?.status === 'failed' && !notify.dismissed))
    return true;
  return Boolean(collectUnresolved(discovery.collect) || downloadUnresolved(discovery.download));
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

/**
 * Compares the target's current picture identity with the last one observed. The first only
 * records it; a different one is an Avatar change, even if that identity was seen before.
 */
export function applyAvatarCheck(
  watch: Watch,
  pictureId: string,
  context: { readonly checkId: string; readonly now: number }
): { readonly watch: Watch; readonly outcome: KindCheckOutcome } {
  const { checkId, now } = context;
  const last = watch.tracking.avatar?.pictureId;
  const tracked: Watch = {
    ...watch,
    tracking: { ...watch.tracking, avatar: { pictureId, lastSuccessAt: now, lastCheckAt: now } },
  };
  if (last === undefined)
    return { watch: tracked, outcome: KindBaselineRecorded.make({ kind: 'avatar' }) };
  const changed = last !== pictureId;
  const found = changed ? [discover({ _tag: 'Avatar', pictureId }, watch, checkId, now)] : [];
  return {
    watch: { ...tracked, discoveries: prune([...watch.discoveries, ...found], now) },
    outcome: KindCheckSucceeded.make({ kind: 'avatar', newCount: found.length, catchUp: false }),
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

const childOutcome = (child: ChildDownload) =>
  ActionOutcome.make({
    state:
      child.status === 'accepted' || child.status === 'confirmed'
        ? 'done'
        : child.status === 'uncertain'
          ? 'unconfirmed'
          : child.status === 'failed'
            ? 'failed'
            : 'waiting',
    ...(child.status === 'failed' ? { code: child.code, dismissed: child.dismissed ?? false } : {}),
  });

function notifyOutcome(notify: NonNullable<Discovery['notify']>): ActionOutcome {
  if (notify.status === 'failed')
    return ActionOutcome.make({
      state: 'failed',
      code: notify.code,
      ...(notify.dismissed ? { dismissed: true } : {}),
    });
  return ActionOutcome.make({ state: notify.status === 'done' ? 'done' : 'waiting' });
}

/** Presents a discovery without its media references. */
/** Whether the entry is still in its Watch's inbox: collected, not removed, and not expired. */
export const inInbox = (discovery: Discovery, now: number) =>
  discovery.collect !== undefined &&
  !('status' in discovery.collect) &&
  discovery.collect.removedAt === undefined &&
  discovery.discoveredAt + RETENTION_MS > now;

export function summarizeDiscovery(
  watch: Watch,
  discovery: Discovery,
  now: number
): DiscoverySummary {
  const { ref } = discovery;
  const download = downloadOutcome(discovery);
  const expiresAt = ref._tag === 'Story' ? new Date(ref.expiresAt * SECOND_MS).toJSON() : null;
  return DiscoverySummary.make({
    entryId: discovery.id,
    ...(discovery.manualExport
      ? { manualExport: planOutcome(discovery.id, discovery.manualExport, ref._tag === 'Sidecar') }
      : {}),
    watchId: watch.id,
    accountId: watch.targetId,
    username: watch.username,
    kind: KIND_OF_REF[ref._tag],
    mediaType:
      ref._tag === 'Sidecar' ? 'sidecar' : ref._tag === 'Avatar' ? 'avatar' : ref.mediaType,
    ...(ref._tag === 'Sidecar' ? { childCount: ref.children.length } : {}),
    discoveredAt: discovery.discoveredAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(inInbox(discovery, now)
      ? {
          inboxUntil: discovery.discoveredAt + RETENTION_MS,
          remainingRetentionMs: discovery.discoveredAt + RETENTION_MS - now,
        }
      : {}),
    ...(discovery.unavailable ? { unavailable: discovery.unavailable } : {}),
    ...(discovery.missingChildren ? { missingChildren: discovery.missingChildren.length } : {}),
    ...(discovery.notify ? { notify: notifyOutcome(discovery.notify) } : {}),
    ...(download ? { download } : {}),
    ...(discovery.download
      ? { downloadChildren: discovery.download.children.map(childOutcome) }
      : {}),
    ...(discovery.collect ? { collect: collectOutcome(discovery.collect) } : {}),
  });
}

function collectOutcome(collect: NonNullable<Discovery['collect']>): ActionOutcome {
  if (!('status' in collect)) return ActionOutcome.make({ state: 'done' });
  if (collect.status === 'pending') return ActionOutcome.make({ state: 'waiting' });
  return ActionOutcome.make({
    state: 'failed',
    code: collect.code,
    ...(collect.dismissed ? { dismissed: true } : {}),
  });
}
