import { Effect, Schema } from 'effect';
import { AccountId, WatchKind, KindCheckOutcome, type FailureCode } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { WatchRequests } from '../instagram/requests.ts';
import type { Watch } from './contracts.ts';
import { refreshBadge } from './attention.ts';
import { checkWatch, type CheckScope } from './check.ts';
import { notifyCheck, resumeNotifications, notificationsNeedWork } from './notify.ts';
import { runActions, actionsNeedWork } from './auto-download.ts';
import { fetchViewer } from './identity.ts';
import { readStore } from './store.ts';

const liveManual = new Set<string>();

export const ALARM_NAME = 'watch-pump';
const STATE_KEY = 'watch-scheduler';
const SESSION_KEY = 'watch-browser-session';
const HOUR_MS = 60 * 60_000;
const ROUND_MS = 12 * HOUR_MS;
const ROUND_JITTER = 0.1;
const STARTUP_HOLD_MS = 2 * 60_000;
const EARLY_RETRY_MS = HOUR_MS;
/** One alarm wakes the worker; it then works this long at most before the next wake. */
const PUMP_BUDGET_MS = 4 * 60_000;

/** Kind failures worth one early retry: the request or answer broke, not the session. */
const RETRYABLE: ReadonlySet<FailureCode> = new Set([
  'SOURCE_NETWORK_FAILED',
  'SOURCE_SERVER_FAILED',
  'IG_RESPONSE_SHAPE_UNKNOWN',
]);
/** Failures that suspend every Watch until the person does something. */
const SUSPENDING: ReadonlySet<FailureCode> = new Set([
  'IG_REQUEST_REJECTED',
  'IG_NOT_AUTHENTICATED',
]);

const suspends = (outcomes: readonly KindCheckOutcome[]) =>
  outcomes.some(outcome =>
    outcome._tag === 'KindCheckSkipped'
      ? outcome.reason === 'login-unverified'
      : outcome._tag === 'KindCheckFailed' && SUSPENDING.has(outcome.code)
  );

const EarlyRetry = Schema.Struct({ watchId: Schema.UUID, kind: WatchKind, at: Schema.Number });

const LoginSchedule = Schema.Struct({
  nextRoundAt: Schema.Number.pipe(Schema.int()),
  /** Watches of the current round still waiting for their turn, in order. */
  remaining: Schema.Array(Schema.UUID),
  /** The current round, whose Watches share one Instants feed. */
  roundId: Schema.optional(Schema.UUID),
  /** Watches whose Posts traversal continues this round once the remaining Watches had a turn. */
  catchUp: Schema.optional(Schema.Array(Schema.UUID)),
  earlyRetries: Schema.Array(EarlyRetry),
  manual: Schema.optional(
    Schema.Array(
      Schema.Struct({
        watchId: Schema.UUID,
        checkId: Schema.UUID,
        remainingKinds: Schema.Array(WatchKind),
        outcomes: Schema.optional(Schema.Array(KindCheckOutcome)),
      })
    )
  ),
});
type LoginSchedule = Schema.Schema.Type<typeof LoginSchedule>;

const SchedulerState = Schema.Struct({
  version: Schema.Literal(1),
  logins: Schema.Record({ key: AccountId, value: LoginSchedule }),
  startupHoldUntil: Schema.optional(Schema.Number),
  /** Set when the session was rejected; cleared when the person next verifies their login. */
  suspended: Schema.optional(Schema.Boolean),
});
type SchedulerState = Schema.Schema.Type<typeof SchedulerState>;

const EMPTY: SchedulerState = { version: 1, logins: {} };

async function loadState(): Promise<SchedulerState> {
  const stored = await browser.storage.get(STATE_KEY).catch((): Record<string, unknown> => ({}));
  const decoded = Schema.decodeUnknownOption(SchedulerState)(stored[STATE_KEY]);
  return decoded._tag === 'Some' ? decoded.value : EMPTY;
}

let writes: Promise<unknown> = Promise.resolve();

/** Applies `change` to the latest scheduler state, one change at a time. */
function updateState(
  change: (state: SchedulerState) => SchedulerState,
  required = false
): Promise<SchedulerState> {
  const run = async () => {
    const next = change(await loadState());
    await browser.storage
      .set({ [STATE_KEY]: Schema.encodeSync(SchedulerState)(next) })
      .catch(cause => {
        if (required) throw cause;
      });
    return next;
  };
  const result = writes.then(run, run);
  writes = result.catch(() => undefined);
  return result;
}

/** The next round starts 12 hours after this one, give or take 10%. */
const nextRoundFrom = (start: number) =>
  Math.round(start + ROUND_MS * (1 - ROUND_JITTER + Math.random() * 2 * ROUND_JITTER));

const lastSuccess = (watch: Watch) =>
  Math.min(...watch.kinds.map(kind => watch.tracking[kind]?.lastSuccessAt ?? 0));

/** Watches whose last successful check is oldest go first. */
const roundOrder = (watches: readonly Watch[]) =>
  [...watches].sort((left, right) => lastSuccess(left) - lastSuccess(right)).map(w => w.id);

/** One Watch at a time: a manual check waits for the current turn, then goes before the next. */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.catch(() => undefined);
  return result;
}

/**
 * Runs one Watch's check after the Watch before it, then books or clears its Posts catch-up for
 * this round, whoever asked for the check.
 */
export async function runCheck(
  watchId: string,
  viewerId: string,
  scope: CheckScope,
  only?: readonly WatchKind[]
) {
  const startedAt = Date.now();
  const run = await exclusive(() =>
    Effect.runPromise(
      checkWatch(watchId, viewerId, scope, only).pipe(Effect.provide(WatchRequests))
    )
  );
  await runActions(watchId, viewerId);
  await notifyCheck(watchId, scope.checkId, startedAt, run.pictureUrl);
  const posts = run.kinds.find(outcome => outcome.kind === 'posts');
  if (posts) {
    const catchingUp = posts._tag === 'KindCheckSucceeded' && posts.catchUp;
    await setSchedule(viewerId, current => {
      const schedule = current ?? { nextRoundAt: Date.now(), remaining: [], earlyRetries: [] };
      const others = (schedule.catchUp ?? []).filter(id => id !== watchId);
      return { ...schedule, catchUp: catchingUp ? [...others, watchId] : others };
    });
  }
  return run;
}

type Job =
  | {
      readonly _tag: 'manual';
      readonly watchId: string;
      readonly checkId: string;
      readonly remainingKinds: readonly WatchKind[];
      readonly outcomes?: readonly KindCheckOutcome[];
    }
  | { readonly _tag: 'round'; readonly watchId: string }
  | { readonly _tag: 'catchUp'; readonly watchId: string }
  | { readonly _tag: 'retry'; readonly watchId: string; readonly kind: WatchKind };

/** The login's next job, starting a new round when the last one is over and the next is due. */
function nextJob(
  schedule: LoginSchedule | undefined,
  watches: readonly Watch[],
  now: number
): { readonly job?: Job; readonly schedule: LoginSchedule } {
  const enabled = new Set(watches.filter(watch => watch.enabled).map(watch => watch.id));
  const current: LoginSchedule = {
    ...(schedule ?? { nextRoundAt: now, remaining: [], earlyRetries: [] }),
    manual: schedule?.manual?.filter(job => watches.some(watch => watch.id === job.watchId)),
  };
  const manual = current.manual?.find(job => watches.some(watch => watch.id === job.watchId));
  if (manual) return { job: { _tag: 'manual', ...manual }, schedule: current };
  const retry = current.earlyRetries.find(item => item.at <= now && enabled.has(item.watchId));
  if (retry) return { job: { _tag: 'retry', ...retry }, schedule: current };
  const remaining = current.remaining.filter(id => enabled.has(id));
  if (remaining[0]) return { job: { _tag: 'round', watchId: remaining[0] }, schedule: current };
  const catchUp = current.catchUp?.find(id => enabled.has(id));
  if (catchUp) return { job: { _tag: 'catchUp', watchId: catchUp }, schedule: current };
  if (current.nextRoundAt > now || enabled.size === 0) return { schedule: current };
  const started: LoginSchedule = {
    ...current,
    roundId: crypto.randomUUID(),
    nextRoundAt: nextRoundFrom(now),
    remaining: roundOrder(watches.filter(watch => enabled.has(watch.id))),
  };
  return { job: { _tag: 'round', watchId: started.remaining[0]! }, schedule: started };
}

/** Records a finished job: drops it, and books one early retry for a kind that broke. */
function finishJob(
  schedule: LoginSchedule,
  job: Job,
  failures: readonly { readonly kind: WatchKind; readonly code: FailureCode }[],
  now: number
): LoginSchedule {
  const earlyRetries = schedule.earlyRetries.filter(
    item => !(job._tag === 'retry' && item.watchId === job.watchId && item.kind === job.kind)
  );
  if (job._tag === 'retry') return { ...schedule, earlyRetries };
  const booked = failures
    .filter(failure => RETRYABLE.has(failure.code))
    .map(failure => ({ watchId: job.watchId, kind: failure.kind, at: now + EARLY_RETRY_MS }));
  return {
    ...schedule,
    remaining: schedule.remaining.filter(id => id !== job.watchId),
    earlyRetries: [...earlyRetries, ...booked],
  };
}

const verifyViewer = () =>
  Effect.runPromise(fetchViewer.pipe(Effect.either, Effect.provide(WatchRequests)));

const hasDueWork = (state: SchedulerState, watches: readonly Watch[]) =>
  watches.some(
    watch =>
      nextJob(state.logins[watch.viewerId], [watch], Date.now()).job !== undefined ||
      actionsNeedWork(watch) ||
      notificationsNeedWork(watch)
  );

/** The verified login whose Watch work may run now, or undefined while nothing may run. */
async function readyViewer(): Promise<string | undefined> {
  const state = await loadState();
  if (state.suspended || (state.startupHoldUntil ?? 0) > Date.now()) return undefined;
  const read = await readStore();
  if (read.kind === 'failed') return undefined;
  if (!hasDueWork(state, read.store.watches)) return undefined;
  const viewer = await verifyViewer();
  if (viewer._tag === 'Right') return viewer.right.accountId;
  if (viewer.left._tag !== 'WatchRequestDeferred' && viewer.left._tag !== 'RateLimited')
    await updateState(current => ({ ...current, suspended: true }));
  return undefined;
}

const setSchedule = (
  viewerId: string,
  schedule: (current: LoginSchedule | undefined) => LoginSchedule
) =>
  updateState(state => ({
    ...state,
    logins: { ...state.logins, [viewerId]: schedule(state.logins[viewerId]) },
  }));

async function recoverManualJob(viewerId: string, job: Extract<Job, { _tag: 'manual' }>) {
  if (liveManual.has(job.checkId)) return false;
  const run = await runCheck(
    job.watchId,
    viewerId,
    {
      checkId: job.checkId,
      feedScope: job.checkId,
      onKind: outcome => checkpointManual(viewerId, job.watchId, job.checkId, outcome),
    },
    job.remainingKinds
  );
  if (run.deferredUntil === undefined)
    await finishManual(viewerId, job.watchId, job.checkId, [...(job.outcomes ?? []), ...run.kinds]);
  await refreshBadge();
  return run.deferredUntil === undefined;
}

function jobKinds(job: Exclude<Job, { _tag: 'manual' }>): readonly WatchKind[] | undefined {
  if (job._tag === 'retry') return [job.kind];
  if (job._tag === 'catchUp') return ['posts'];
  return undefined;
}

async function nextDueJob(viewerId: string) {
  const read = await readStore();
  if (read.kind === 'failed') return undefined;
  const watches = read.store.watches.filter(watch => watch.viewerId === viewerId);
  const { job, schedule } = nextJob((await loadState()).logins[viewerId], watches, Date.now());
  await setSchedule(viewerId, () => schedule);
  if (!job) return undefined;
  return { job, schedule };
}

/** Runs the login's next due job. False when nothing more should run in this wake. */
async function runNextJob(viewerId: string): Promise<boolean> {
  const next = await nextDueJob(viewerId);
  if (!next) return false;
  const { job, schedule } = next;
  if (job._tag === 'manual') return await recoverManualJob(viewerId, job);
  const only = jobKinds(job);
  const checkId = crypto.randomUUID();
  const feedScope = job._tag === 'round' ? `round:${schedule.roundId ?? checkId}` : checkId;
  const run = await runCheck(job.watchId, viewerId, { checkId, feedScope }, only);

  await refreshBadge();
  if (run.deferredUntil !== undefined) return false;
  const failures = run.kinds.flatMap(outcome =>
    outcome._tag === 'KindCheckFailed' ? [{ kind: outcome.kind, code: outcome.code }] : []
  );
  if (suspends(run.kinds)) {
    await updateState(current => ({ ...current, suspended: true }));
    return false;
  }
  await setSchedule(viewerId, current => finishJob(current ?? schedule, job, failures, Date.now()));
  return true;
}

/**
 * Runs whatever Watch work is due for the signed-in login, checkpointing after every Watch so a
 * suspended worker resumes where it stopped. Throttling ends the run until the next wake.
 */
async function pumpOnce(deadline: number): Promise<void> {
  if (
    !(await initializeScheduler().then(
      () => true,
      () => false
    ))
  )
    return;
  const viewerId = await readyViewer();
  if (!viewerId) return;
  const read = await readStore();
  if (read.kind === 'ok') {
    for (const watch of read.store.watches)
      if (watch.viewerId === viewerId && watch.enabled) {
        await runActions(watch.id, viewerId);
        await resumeNotifications(watch.id);
      }
  }
  while (Date.now() < deadline && (await runNextJob(viewerId)));
}

let pumping: Promise<void> | undefined;

/** Starts a pump unless one is already running in this worker. */
export function pump(): Promise<void> {
  pumping ??= pumpOnce(Date.now() + PUMP_BUDGET_MS).finally(() => (pumping = undefined));
  return pumping;
}

let initializing: Promise<void> | undefined;

export function initializeScheduler(): Promise<void> {
  initializing ??= (async () => {
    const session = await browser.sessionStorage.get(SESSION_KEY);
    if (session[SESSION_KEY] !== true) {
      await holdForStartup();
      await browser.sessionStorage.set({ [SESSION_KEY]: true });
    }
    await ensureAlarm();
  })();
  return initializing;
}

/** Creates the single periodic alarm if the browser does not already have it. */
export async function ensureAlarm(): Promise<void> {
  const existing = await browser.alarms.get(ALARM_NAME).catch(() => undefined);
  if (!existing) await browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

/** Browser start: overdue work waits two minutes, then runs through the same queue. */
export async function holdForStartup(): Promise<void> {
  await updateState(state => ({ ...state, startupHoldUntil: Date.now() + STARTUP_HOLD_MS }), true);
}

/** A person verified their login again, so suspended Watches may run. */
export async function resumeAfterPerson(): Promise<void> {
  const state = await loadState();
  if (state.suspended) await updateState(current => ({ ...current, suspended: undefined }));
}

/** When the verified login's next round starts, and how many Watches its current round has left. */
export async function scheduleOf(viewerId: string) {
  const state = await loadState();
  const schedule = state.logins[viewerId];
  return {
    nextRoundAt: schedule?.nextRoundAt,
    roundRemaining: schedule?.remaining.length ?? 0,
    suspended: state.suspended ?? false,
  };
}

export async function queueManual(viewerId: string, checkId: string, watches: readonly Watch[]) {
  const watchIds = new Set<string>();
  if (watches.length === 0) return { watchIds, release: () => {} };
  liveManual.add(checkId);
  try {
    await updateState(state => {
      const current = state.logins[viewerId] ?? {
        nextRoundAt: nextRoundFrom(Date.now()),
        remaining: [],
        earlyRetries: [],
      };
      return {
        ...state,
        logins: {
          ...state.logins,
          [viewerId]: {
            ...current,
            manual: [
              ...(current.manual ?? []),
              ...watches
                .filter(watch => !current.manual?.some(job => job.watchId === watch.id))
                .map(watch => {
                  watchIds.add(watch.id);
                  return {
                    watchId: watch.id,
                    checkId,
                    remainingKinds: watch.kinds,
                    outcomes: [],
                  };
                }),
            ],
          },
        },
      };
    }, true);
  } catch (cause) {
    liveManual.delete(checkId);
    throw cause;
  }
  return {
    watchIds,
    release: () => {
      liveManual.delete(checkId);
    },
  };
}

export async function checkpointManual(
  viewerId: string,
  watchId: string,
  checkId: string,
  outcome: import('@gramgrab/protocol').KindCheckOutcome
) {
  if (outcome._tag === 'KindCheckSkipped' && outcome.reason === 'deferred') return;
  await updateState(state => {
    const current = state.logins[viewerId];
    if (!current) return state;
    return {
      ...state,
      logins: {
        ...state.logins,
        [viewerId]: {
          ...current,
          manual: current.manual?.map(job =>
            job.watchId === watchId && job.checkId === checkId
              ? {
                  ...job,
                  remainingKinds: job.remainingKinds.filter(kind => kind !== outcome.kind),
                  outcomes: [
                    ...(job.outcomes ?? []).filter(previous => previous.kind !== outcome.kind),
                    outcome,
                  ],
                }
              : job
          ),
        },
      },
    };
  }, true);
}

export async function finishManual(
  viewerId: string,
  watchId: string,
  checkId: string,
  outcomes: readonly import('@gramgrab/protocol').KindCheckOutcome[] = []
) {
  const completed = new Set(
    outcomes.filter(outcome => outcome._tag !== 'KindCheckSkipped').map(outcome => outcome.kind)
  );
  const failures = outcomes.flatMap(outcome =>
    outcome._tag === 'KindCheckFailed' && RETRYABLE.has(outcome.code)
      ? [{ watchId, kind: outcome.kind, at: Date.now() + EARLY_RETRY_MS }]
      : []
  );
  if (suspends(outcomes)) await updateState(state => ({ ...state, suspended: true }));
  await setSchedule(viewerId, current => ({
    ...(current ?? { nextRoundAt: Date.now(), remaining: [], earlyRetries: [] }),
    manual: current?.manual?.filter(job => job.watchId !== watchId || job.checkId !== checkId),
    earlyRetries: [
      ...(current?.earlyRetries ?? []).filter(
        retry => retry.watchId !== watchId || !completed.has(retry.kind)
      ),
      ...failures,
    ],
  }));
}
