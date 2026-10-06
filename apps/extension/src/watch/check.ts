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
  applyAvatarCheck,
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
import { readInstants, sharedInstantsFeed } from './instants.ts';
import { fetchAvatar, readAvatar } from './avatar.ts';
import { UsernameUnconfirmed, confirmProfile, fetchViewer } from './identity.ts';
import { mutateStore, readStore } from './store.ts';

/**
 * One Watch's check runs these stages in order. `profile` confirms the current username by
 * account ID, which the Avatar and Posts requests after it look up by.
 */
const STAGES = ['stories', 'instants', 'profile', 'avatar', 'posts'] as const;

/** Kinds whose requests need the confirmed current username. */
const NEEDS_PROFILE = ['avatar', 'posts'] as const satisfies readonly WatchKind[];

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
  | PostsIncomplete
  | UsernameUnconfirmed;

type Acquirer = (
  watch: Watch,
  nowSeconds: number,
  feedScope: string
) => Effect.Effect<readonly TimedRef[], Acquisition, InstagramRequests>;

const readPage = (watch: Watch, after: string | undefined, nowSeconds: number) =>
  fetchPostsPage(watch.username, after).pipe(
    Effect.flatMap(raw => readPostsPage(raw, watch.targetId, nowSeconds))
  );

/** How each timed kind acquires its baseline, and Stories and Instants every later check too. */
const ACQUIRERS: Record<TimedKind, Acquirer> = {
  stories: (watch, nowSeconds) =>
    fetchStories(watch.targetId).pipe(
      Effect.flatMap(raw => readStories(raw, watch.targetId, nowSeconds))
    ),
  instants: (watch, nowSeconds, feedScope) =>
    sharedInstantsFeed(feedScope).pipe(
      Effect.flatMap(items => readInstants(items, watch.targetId, nowSeconds))
    ),
  posts: (watch, nowSeconds) =>
    readPage(watch, undefined, nowSeconds).pipe(Effect.map(page => page.refs)),
};

/** The time throttling holds Watch work until, or undefined when the failure is the kind's own. */
function deferral(
  error: Acquisition | Effect.Effect.Error<typeof fetchViewer>
): number | undefined {
  if (error._tag === 'WatchRequestDeferred') return error.until;
  if (error._tag === 'RateLimited') return requestLedger.pausedUntil(Date.now()) ?? Date.now();
  return undefined;
}

const failureCode = (error: Acquisition): FailureCode => {
  if (error._tag === 'PostsIncomplete') return 'WATCH_CHECK_INCOMPLETE';
  if (error._tag === 'UsernameUnconfirmed') return 'WATCH_USERNAME_UNCONFIRMED';
  return normalizeSourceFailure(error).code;
};

const findWatch = async (watchId: string, viewerId: string) => {
  const read = await readStore();
  return read.kind === 'ok'
    ? read.store.watches.find(watch => watch.id === watchId && watch.viewerId === viewerId)
    : undefined;
};

/**
 * One check's identity, and the scope whose Watches share one Instants feed: a round, or one
 * person-initiated check of several Watches.
 */
export interface CheckScope {
  readonly checkId: string;
  readonly feedScope: string;
  readonly onKind?: (outcome: KindCheckOutcome) => void | Promise<void>;
}

/** One kind's turn: its outcome, and whether the rest of the check must stop. */
interface KindStep {
  readonly outcome?: KindCheckOutcome;
  readonly stop?: boolean;
  readonly deferredUntil?: number;
  /** The target's current Avatar URL, held only until this check's notification is sent. */
  readonly pictureUrl?: string;
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
  kind: WatchKind,
  write: { readonly kind: 'ok'; readonly value: T | undefined } | { readonly kind: 'failed' },
  step: (value: T) => KindStep
): KindStep {
  if (write.kind === 'failed')
    return { outcome: KindCheckSkipped.make({ kind, reason: 'storage' }), stop: true };
  return write.value === undefined ? { stop: true } : step(write.value);
}

/** A kind's failed acquisition: throttling defers the check, anything else is the kind's problem. */
const failed = (watchId: string, kind: WatchKind, error: Acquisition) =>
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

const checkKind = (watch: Watch, kind: TimedKind, acquire: Acquirer, scope: CheckScope) =>
  Effect.gen(function* () {
    const { checkId } = scope;
    const proposedCutoff = Math.floor(Date.now() / 1000);
    const result = yield* Effect.either(acquire(watch, proposedCutoff, scope.feedScope));
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
 * last page or at the first page with no eligible media. A page that only reaches older media
 * does not end it, since pinned and reordered Posts put older media above newer.
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
      !refs.some(ref => eligible(ref.takenAt, context.cutoff, context.windowStart));
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
      last: refs.at(-1)!.mediaId,
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

const checkAvatar = (watch: Watch, checkId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(
      fetchAvatar(watch.username).pipe(
        Effect.flatMap(raw => readAvatar(raw, watch.targetId, watch.username))
      )
    );
    if (Either.isLeft(result)) return yield* failed(watch.id, 'avatar', result.left);
    const write = yield* update(watch.id, (current, now) => {
      const applied = applyAvatarCheck(current, result.right.pictureId, { checkId, now });
      return { watch: applied.watch, value: applied.outcome };
    });
    return written('avatar', write, outcome => ({ outcome, pictureUrl: result.right.pictureUrl }));
  });

/** A selected kind's turn in a check: skipped while paused, checked otherwise. */
const turn = (
  watch: Watch,
  kind: WatchKind,
  scope: CheckScope
): Effect.Effect<KindStep, never, InstagramRequests> => {
  if (!watch.enabled)
    return Effect.succeed({ outcome: KindCheckSkipped.make({ kind, reason: 'paused' }) });
  if (kind === 'avatar') return checkAvatar(watch, scope.checkId);
  const cutoff = watch.tracking[kind]?.baselineCutoff;
  if (kind === 'posts' && cutoff !== undefined) return traversePosts(watch, cutoff, scope.checkId);
  return checkKind(watch, kind, ACQUIRERS[kind], scope);
};

/** The current username follows a verified rename, keeping the one before it. */
const renamed = (watch: Watch, username: string): Watch =>
  watch.username === username ? watch : { ...watch, username, formerUsername: watch.username };

/**
 * Confirms the current username for the kinds that need it. A failure is each of those kinds'
 * problem, and they are not checked this time.
 */
const profileStage = (watch: Watch, kinds: readonly WatchKind[]) =>
  Effect.gen(function* () {
    const result = yield* Effect.either(confirmProfile(watch.targetId));
    if (Either.isRight(result)) {
      const write = yield* update(watch.id, current => ({
        watch: renamed(current, result.right.username),
        value: true,
      }));
      return { steps: [written(kinds[0]!, write, () => ({}))], blocked: false };
    }
    const steps: KindStep[] = [];
    for (const kind of kinds) {
      const step = yield* failed(watch.id, kind, result.left);
      steps.push(step);
      if (step.stop) break;
    }
    return { steps, blocked: true };
  });

const selected = (watch: Watch, kind: WatchKind, only: readonly WatchKind[] | undefined) =>
  watch.kinds.includes(kind) && (!only || only.includes(kind));

/** A stage's steps, and whether it leaves the username-dependent kinds blocked. */
interface StageResult {
  readonly steps: readonly KindStep[];
  readonly blocked: boolean;
}

const runStage = (
  watch: Watch,
  stage: (typeof STAGES)[number],
  only: readonly WatchKind[] | undefined,
  context: { readonly scope: CheckScope; readonly blocked: boolean }
): Effect.Effect<StageResult, never, InstagramRequests> => {
  const { scope, blocked } = context;
  if (stage !== 'profile')
    return selected(watch, stage, only) && !blocked
      ? turn(watch, stage, scope).pipe(Effect.map(step => ({ steps: [step], blocked })))
      : Effect.succeed({ steps: [], blocked });
  const kinds = NEEDS_PROFILE.filter(kind => selected(watch, kind, only));
  return kinds.length > 0 && watch.enabled
    ? profileStage(watch, kinds)
    : Effect.succeed({ steps: [], blocked });
};

const checkAuthorization = Effect.fn(function* (
  watch: Watch,
  scope: CheckScope,
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
  for (const outcome of kinds)
    yield* Effect.promise(() => Promise.resolve(scope.onKind?.(outcome)));
  return { kinds, deferredUntil: until };
});

const authorizeStage = Effect.fn(function* (
  watch: Watch,
  stage: (typeof STAGES)[number],
  scope: CheckScope,
  only: readonly WatchKind[] | undefined,
  completed: readonly KindCheckOutcome[]
) {
  const chosen =
    stage === 'profile'
      ? NEEDS_PROFILE.some(kind => selected(watch, kind, only))
      : selected(watch, stage, only);
  if (!chosen) return undefined;
  return yield* checkAuthorization(watch, scope, only, completed);
});

/**
 * Checks one Watch of `viewerId` stage by stage, or only the `only` kinds, committing each kind's
 * result before the next starts. A Watch deleted meanwhile is left deleted: its late results are
 * dropped.
 */
export const checkWatch = (
  watchId: string,
  viewerId: string,
  scope: CheckScope,
  only?: readonly WatchKind[]
) =>
  Effect.gen(function* () {
    const shared = { ...scope, feedScope: `${viewerId}:${scope.feedScope}` };
    const outcomes: KindCheckOutcome[] = [];
    let blocked = false;
    let pictureUrl: string | undefined;
    for (const stage of STAGES) {
      const watch = yield* Effect.promise(() => findWatch(watchId, viewerId));
      if (!watch) break;
      const authorization = yield* authorizeStage(watch, stage, scope, only, outcomes);
      if (authorization)
        return { ...authorization, kinds: [...outcomes, ...authorization.kinds], pictureUrl };
      const result: StageResult = yield* runStage(watch, stage, only, { scope: shared, blocked });
      blocked = result.blocked;
      for (const step of result.steps) {
        const outcome = step.outcome;
        if (outcome) {
          outcomes.push(outcome);
          yield* Effect.promise(() => Promise.resolve(scope.onKind?.(outcome)));
        }
        pictureUrl ??= step.pictureUrl;
        if (step.stop) return { kinds: outcomes, deferredUntil: step.deferredUntil, pictureUrl };
      }
    }
    return { kinds: outcomes, deferredUntil: undefined, pictureUrl };
  });

/** The most recent check of any of the Watch's kinds. */
export const lastCheckAt = (watch: Watch): number | undefined => {
  const times = WATCH_KINDS.flatMap(kind => watch.tracking[kind]?.lastCheckAt ?? []);
  return times.length > 0 ? Math.max(...times) : undefined;
};
