import { Effect, Either } from 'effect';
import {
  KindCheckFailed,
  KindCheckSkipped,
  WATCH_KINDS,
  type KindCheckOutcome,
  type WatchKind,
} from '@gramgrab/protocol';
import { normalizeSourceFailure } from '../errors/normalize.ts';
import {
  requestLedger,
  type InstagramRequests,
  type WatchRequestDeferred,
} from '../instagram/requests.ts';
import type {
  GraphQLRequestFailed,
  HttpError,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
} from '../effect/errors.ts';
import type { TimedRef, Watch } from './contracts.ts';
import { applyKindProblem, applyTimedCheck } from './discoveries.ts';
import { readStories, fetchStories } from './stories.ts';
import { mutateStore, readStore } from './store.ts';
import { fetchViewer } from './identity.ts';

/** Kinds run in this order within one Watch's check. */
const KIND_ORDER = [
  'stories',
  'instants',
  'avatar',
  'posts',
] as const satisfies readonly WatchKind[];

type TimedKind = Exclude<WatchKind, 'avatar'>;

/** A Watch cannot be checked on request again this soon after its last check. */
export const MANUAL_CHECK_INTERVAL_MS = 5 * 60_000;

type Acquisition =
  | GraphQLRequestFailed
  | HttpError
  | NetworkError
  | RateLimited
  | ResponseShapeUnknown
  | WatchRequestDeferred;

type Acquirer = (
  watch: Watch,
  nowSeconds: number
) => Effect.Effect<readonly TimedRef[], Acquisition, InstagramRequests>;

const ACQUIRERS: Partial<Record<TimedKind, Acquirer>> = {
  stories: (watch, nowSeconds) =>
    fetchStories(watch.targetId).pipe(
      Effect.flatMap(raw => readStories(raw, watch.targetId, nowSeconds))
    ),
};

/** The time throttling holds Watch work until, or undefined when the failure is the kind's own. */
function deferral(
  error: Acquisition | Effect.Effect.Error<typeof fetchViewer>
): number | undefined {
  if (error._tag === 'WatchRequestDeferred') return error.until;
  if (error._tag === 'RateLimited') return requestLedger.pause?.until ?? Date.now();
  return undefined;
}

/** Applies one kind's acquisition, or its failure, to the Watch as it is now stored. */
function applyResult(
  watch: Watch,
  kind: TimedKind,
  result: Either.Either<readonly TimedRef[], Acquisition>,
  context: { readonly checkId: string; readonly proposedCutoff: number; readonly now: number }
) {
  if (Either.isRight(result)) return applyTimedCheck(watch, kind, result.right, context);
  const code = normalizeSourceFailure(result.left).code;
  return {
    watch: applyKindProblem(watch, kind, code, context.now),
    outcome: KindCheckFailed.make({ kind, code }),
  };
}

const findWatch = async (watchId: string, viewerId: string) => {
  const read = await readStore();
  return read.kind === 'ok'
    ? read.store.watches.find(watch => watch.id === watchId && watch.viewerId === viewerId)
    : undefined;
};

/** One kind's turn: its outcome, and whether the rest of the check must stop. */
interface KindStep {
  readonly outcome?: KindCheckOutcome;
  readonly stop?: boolean;
  readonly deferredUntil?: number;
}

/** Saves one kind's result to the Watch as it is stored now; a deleted Watch stays deleted. */
const commit = (
  watchId: string,
  kind: TimedKind,
  result: Either.Either<readonly TimedRef[], Acquisition>,
  context: { readonly checkId: string; readonly proposedCutoff: number }
) =>
  Effect.promise(() =>
    mutateStore(store => {
      const current = store.watches.find(candidate => candidate.id === watchId);
      if (!current) return { store, value: undefined };
      const applied = applyResult(current, kind, result, { ...context, now: Date.now() });
      return {
        store: {
          ...store,
          watches: store.watches.map(candidate =>
            candidate.id === watchId ? applied.watch : candidate
          ),
        },
        value: applied.outcome,
      };
    })
  );

const checkKind = (watch: Watch, kind: TimedKind, acquire: Acquirer, checkId: string) =>
  Effect.gen(function* () {
    const proposedCutoff = Math.floor(Date.now() / 1000);
    const result = yield* Effect.either(acquire(watch, proposedCutoff));
    const until = Either.isLeft(result) ? deferral(result.left) : undefined;
    if (until !== undefined)
      return {
        outcome: KindCheckSkipped.make({ kind, reason: 'deferred' }),
        stop: true,
        deferredUntil: until,
      } satisfies KindStep;
    const write = yield* commit(watch.id, kind, result, { checkId, proposedCutoff });
    if (write.kind === 'failed')
      return {
        outcome: KindCheckSkipped.make({ kind, reason: 'storage' }),
        stop: true,
      } satisfies KindStep;
    return (write.value ? { outcome: write.value } : { stop: true }) satisfies KindStep;
  });

/** A selected kind's turn in a check: skipped while paused, checked otherwise. */
const turn = (
  watch: Watch,
  kind: TimedKind,
  checkId: string
): Effect.Effect<KindStep, never, InstagramRequests> => {
  const acquire = ACQUIRERS[kind];
  if (!acquire) return Effect.succeed({});
  if (!watch.enabled)
    return Effect.succeed({ outcome: KindCheckSkipped.make({ kind, reason: 'paused' }) });
  return checkKind(watch, kind, acquire, checkId);
};

const selected = (watch: Watch, kind: WatchKind, only: readonly WatchKind[] | undefined) =>
  watch.kinds.includes(kind) && (!only || only.includes(kind));

const checkAuthorization = Effect.fn(function* (
  watch: Watch,
  only: readonly WatchKind[] | undefined,
  completed: readonly KindCheckOutcome[]
) {
  if (!watch.enabled) return undefined;
  const viewer = yield* Effect.either(fetchViewer);
  if (Either.isRight(viewer) && viewer.right.accountId === watch.viewerId) return undefined;
  const until = Either.isLeft(viewer) ? deferral(viewer.left) : undefined;
  const kinds = watch.kinds
    .filter(
      kind => selected(watch, kind, only) && !completed.some(outcome => outcome.kind === kind)
    )
    .map(kind =>
      KindCheckSkipped.make({ kind, reason: until === undefined ? 'login-unverified' : 'deferred' })
    );
  return { kinds, deferredUntil: until };
});

/**
 * Checks one Watch of `viewerId` kind by kind, or only the `only` kinds, committing each kind's
 * result before the next starts. A Watch deleted meanwhile is left deleted: its late results are
 * dropped.
 */
export const checkWatch = (
  watchId: string,
  viewerId: string,
  checkId: string,
  only?: readonly WatchKind[]
) =>
  Effect.gen(function* () {
    const outcomes: KindCheckOutcome[] = [];
    for (const kind of KIND_ORDER) {
      const watch = yield* Effect.promise(() => findWatch(watchId, viewerId));
      if (!watch) break;
      if (kind === 'avatar' || !selected(watch, kind, only)) continue;
      const authorization = yield* checkAuthorization(watch, only, outcomes);
      if (authorization) return { ...authorization, kinds: [...outcomes, ...authorization.kinds] };
      const step = yield* turn(watch, kind, checkId);
      if (step.outcome) outcomes.push(step.outcome);
      if (step.stop) return { kinds: outcomes, deferredUntil: step.deferredUntil };
    }
    return { kinds: outcomes, deferredUntil: undefined };
  });

/** The most recent check of any of the Watch's kinds. */
export const lastCheckAt = (watch: Watch): number | undefined => {
  const times = WATCH_KINDS.flatMap(kind => watch.tracking[kind]?.lastCheckAt ?? []);
  return times.length > 0 ? Math.max(...times) : undefined;
};
