import { Effect, Either } from 'effect';
import {
  KindCheckFailed,
  KindCheckSkipped,
  KindCheckSucceeded,
  WATCH_KINDS,
  type FailureCode,
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
import type { TimedRef, TimedTracking, Watch } from './contracts.ts';
import {
  applyKindProblem,
  applyTimedCheck,
  discoverNew,
  eligible,
  windowStartAt,
} from './discoveries.ts';
import {
  PAGES_PER_TURN,
  PostsIncomplete,
  continues,
  fetchPostsPage,
  loadTraversal,
  readPostsPage,
  saveTraversal,
  type Traversal,
} from './posts.ts';
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
  | WatchRequestDeferred
  | PostsIncomplete;

type Acquirer = (
  watch: Watch,
  nowSeconds: number
) => Effect.Effect<readonly TimedRef[], Acquisition, InstagramRequests>;

const readPage = (watch: Watch, after: string | undefined, nowSeconds: number) =>
  fetchPostsPage(watch.username, after).pipe(
    Effect.flatMap(raw => readPostsPage(raw, watch.targetId, nowSeconds))
  );

/** How each timed kind acquires its baseline, and Stories every later check too. */
const ACQUIRERS: Partial<Record<TimedKind, Acquirer>> = {
  stories: (watch, nowSeconds) =>
    fetchStories(watch.targetId).pipe(
      Effect.flatMap(raw => readStories(raw, watch.targetId, nowSeconds))
    ),
  posts: (watch, nowSeconds) =>
    readPage(watch, undefined, nowSeconds).pipe(Effect.map(page => page.refs)),
};

/** The time throttling holds Watch work until, or undefined when the failure is the kind's own. */
function deferral(
  error: Acquisition | Effect.Effect.Error<typeof fetchViewer>
): number | undefined {
  if (error._tag === 'WatchRequestDeferred') return error.until;
  if (error._tag === 'RateLimited') return requestLedger.pause?.until ?? Date.now();
  return undefined;
}

const failureCode = (error: Acquisition): FailureCode =>
  error._tag === 'PostsIncomplete' ? 'WATCH_CHECK_INCOMPLETE' : normalizeSourceFailure(error).code;

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

/**
 * Applies `change` to the Watch as it is stored now. A deleted Watch stays deleted, so its value
 * is undefined.
 */
const update = <T>(
  watchId: string,
  change: (watch: Watch, now: number) => { readonly watch: Watch; readonly value: T }
) =>
  Effect.promise(() =>
    mutateStore(store => {
      const current = store.watches.find(candidate => candidate.id === watchId);
      if (!current) return { store, value: undefined };
      const applied = change(current, Date.now());
      return {
        store: {
          ...store,
          watches: store.watches.map(candidate =>
            candidate.id === watchId ? applied.watch : candidate
          ),
        },
        value: applied.value,
      };
    })
  );

/** The step a committed write leads to: storage failure and deletion both end the check. */
function written<T>(
  kind: TimedKind,
  write: { readonly kind: 'ok'; readonly value: T | undefined } | { readonly kind: 'failed' },
  step: (value: T) => KindStep
): KindStep {
  if (write.kind === 'failed')
    return { outcome: KindCheckSkipped.make({ kind, reason: 'storage' }), stop: true };
  return write.value === undefined ? { stop: true } : step(write.value);
}

/** A kind's failed acquisition: throttling defers the check, anything else is the kind's problem. */
const failed = (watchId: string, kind: TimedKind, error: Acquisition) =>
  Effect.gen(function* () {
    const until = deferral(error);
    if (until !== undefined)
      return {
        outcome: KindCheckSkipped.make({ kind, reason: 'deferred' }),
        stop: true,
        deferredUntil: until,
      } satisfies KindStep;
    const code = failureCode(error);
    const write = yield* update(watchId, (watch, now) => ({
      watch: applyKindProblem(watch, kind, code, now),
      value: KindCheckFailed.make({ kind, code }),
    }));
    return written(kind, write, outcome => ({ outcome }));
  });

const checkKind = (watch: Watch, kind: TimedKind, acquire: Acquirer, checkId: string) =>
  Effect.gen(function* () {
    const proposedCutoff = Math.floor(Date.now() / 1000);
    const result = yield* Effect.either(acquire(watch, proposedCutoff));
    if (Either.isLeft(result)) return yield* failed(watch.id, kind, result.left);
    const write = yield* update(watch.id, (current, now) => {
      const applied = applyTimedCheck(current, kind, result.right, {
        checkId,
        proposedCutoff,
        now,
      });
      return { watch: applied.watch, value: applied.outcome };
    });
    return written(kind, write, outcome => ({ outcome }));
  });

const withPosts = (watch: Watch, posts: TimedTracking): Watch => ({
  ...watch,
  tracking: { ...watch.tracking, posts },
});

/** One Posts page's result: the traversal completed, continues, or ended the kind's turn early. */
type PageStep =
  | { readonly _tag: 'done'; readonly newCount: number }
  | { readonly _tag: 'continue'; readonly traversal: Traversal; readonly newCount: number }
  | { readonly _tag: 'end'; readonly step: KindStep };

/** The page after `traversal`, which must continue it, or the newest page. */
const readNext = (watch: Watch, traversal: Traversal | undefined) =>
  readPage(watch, traversal?.next, Math.floor(Date.now() / 1000)).pipe(
    Effect.filterOrFail(
      page => continues(traversal, page),
      () => new PostsIncomplete()
    )
  );

interface TraversalContext {
  readonly cutoff: number;
  readonly windowStart: number;
  readonly checkId: string;
}

/** Records one page's discoveries, and the check's success when the page completes it. */
const recordPage = (
  watchId: string,
  refs: readonly TimedRef[],
  done: boolean,
  context: TraversalContext
) =>
  update(watchId, (current, now) => {
    const found = discoverNew(current, refs, { ...context, now });
    const posts: TimedTracking = done
      ? { baselineCutoff: context.cutoff, lastSuccessAt: now, lastCheckAt: now }
      : (current.tracking.posts ?? {});
    return { watch: withPosts(found.watch, posts), value: found.newCount };
  });

/**
 * Reads the traversal's next page and records what it found. The traversal ends at Instagram's
 * last page or at the first page reaching media that is no longer eligible: under the accepted
 * newest-first ordering, every later page is older still.
 */
const postsPageStep = (watch: Watch, traversal: Traversal | undefined, context: TraversalContext) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(readNext(watch, traversal));
    if (Either.isLeft(result)) {
      if (deferral(result.left) === undefined) yield* saveTraversal(watch.id, undefined);
      return {
        _tag: 'end',
        step: yield* failed(watch.id, 'posts', result.left),
      } satisfies PageStep;
    }
    const { refs, next } = result.right;
    const done =
      next === undefined ||
      refs.some(ref => !eligible(ref.takenAt, context.cutoff, context.windowStart));
    const write = yield* recordPage(watch.id, refs, done, context);
    if (write.kind === 'failed' || write.value === undefined) {
      yield* saveTraversal(watch.id, undefined);
      return { _tag: 'end', step: written('posts', write, () => ({})) } satisfies PageStep;
    }
    if (done) {
      yield* saveTraversal(watch.id, undefined);
      return { _tag: 'done', newCount: write.value } satisfies PageStep;
    }
    const continued: Traversal = {
      windowStart: context.windowStart,
      next,
      cursors: [...(traversal?.cursors ?? []), next],
      last: refs.at(-1)!,
    };
    yield* saveTraversal(watch.id, continued);
    return { _tag: 'continue', traversal: continued, newCount: write.value } satisfies PageStep;
  });

/**
 * Reads up to three more Posts pages of the traversal checkpointed for this Watch, or of a new
 * one, discovering as it goes. A traversal that needs more pages is catching up and continues on
 * the Watch's next turn from its checkpoint, within the window it started with.
 */
const traversePosts = (watch: Watch, cutoff: number, checkId: string) =>
  Effect.gen(function* () {
    let traversal = yield* loadTraversal(watch.id);
    const windowStart = traversal?.windowStart ?? windowStartAt(Date.now());
    let newCount = 0;
    const succeeded = (catchUp: boolean) =>
      KindCheckSucceeded.make({ kind: 'posts', newCount, catchUp });
    for (let page = 0; page < PAGES_PER_TURN; page++) {
      const step = yield* postsPageStep(watch, traversal, { cutoff, windowStart, checkId });
      if (step._tag === 'end') return step.step;
      newCount += step.newCount;
      if (step._tag === 'done') return { outcome: succeeded(false) } satisfies KindStep;
      traversal = step.traversal;
    }
    const write = yield* update(watch.id, (current, now) => ({
      watch: withPosts(current, { ...current.tracking.posts, lastCheckAt: now, catchingUp: true }),
      value: succeeded(true),
    }));
    return written('posts', write, outcome => ({ outcome }));
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
  const cutoff = watch.tracking[kind]?.baselineCutoff;
  if (kind === 'posts' && cutoff !== undefined) return traversePosts(watch, cutoff, checkId);
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
