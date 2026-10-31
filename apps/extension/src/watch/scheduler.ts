import { Effect, Schema } from 'effect';
import {
  WatchKind,
  KindCheckOutcome,
  type DeferredReason,
  type FailureCode,
  type InstagramLogin,
} from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { WatchRequests, ledgerOf, loginOf } from '../instagram/requests.ts';
import { linkedLoginSupported, readLinkedLogin } from '../instagram/linked-login.ts';
import type { Watch } from './contracts.ts';
import {
  SCHEDULER_KEY,
  SUSPENDED_KEYS,
  SchedulerState,
  decodeSchedulerState,
  manualChecks,
  watchSchedule,
  type LoginSchedule,
} from './schedule-state.ts';
import { refreshBadge } from './attention.ts';
import { checkWatch, checkNeedsLogin, type CheckScope } from './check.ts';
import { notifyCheck, resumeNotifications, notificationsNeedWork } from './notify.ts';
import { runActions, actionsNeedWork } from './auto-download.ts';
import { refreshAvatarImage } from './avatar-image.ts';
import { fetchViewer } from './identity.ts';
import { readStore } from './store.ts';

const liveManual = new Set<string>();

export const ALARM_NAME = 'watch-pump';
const SESSION_KEY = 'watch-browser-session';
const HOUR_MS = 60 * 60_000;
const ROUND_MS = 12 * HOUR_MS;
const ROUND_JITTER = 0.1;
const STARTUP_HOLD_MS = 2 * 60_000;
const EARLY_RETRY_MS = HOUR_MS;
/** One alarm wakes the worker; it then works this long at most before the next wake. */
const PUMP_BUDGET_MS = 4 * 60_000;

/** Kind failures a newer GramGrab may read correctly: the answer did not fit what this one knows. */
const ANSWER_FAILURES: ReadonlySet<FailureCode> = new Set([
  'IG_RESPONSE_SHAPE_UNKNOWN',
  'WATCH_CHECK_INCOMPLETE',
]);

/** Kind failures worth one early retry: the request or answer broke, not the session. */
const RETRYABLE: ReadonlySet<FailureCode> = new Set([
  'SOURCE_NETWORK_FAILED',
  'SOURCE_SERVER_FAILED',
  ...ANSWER_FAILURES,
]);
async function loadState(): Promise<SchedulerState> {
  const stored = await browser.storage
    .get(SCHEDULER_KEY)
    .catch((): Record<string, unknown> => ({}));
  return decodeSchedulerState(stored[SCHEDULER_KEY]);
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
      .set({ [SCHEDULER_KEY]: Schema.encodeSync(SchedulerState)(next) })
      .catch(cause => {
        if (required) throw cause;
      });
    return next;
  };
  const result = writes.then(run, run);
  writes = result.catch(() => undefined);
  return result;
}

/** Whether Watches of `viewerId` run as `login`: the linked login owns only the linked account's. */
const runsAs = (login: InstagramLogin, viewerId: string, linkedId: string | undefined) =>
  (viewerId === linkedId) === (login === 'linked');

/** Stops `login`'s Watch work until the person verifies that login again. */
const suspend = (login: InstagramLogin) =>
  updateState(state => ({ ...state, [SUSPENDED_KEYS[login]]: true }));

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
  const login = await loginOf(viewerId);
  const checked = await exclusive(() =>
    Effect.runPromise(
      checkWatch(watchId, viewerId, scope, only).pipe(Effect.provide(WatchRequests(login)))
    )
  );
  const run = { ...checked, login };
  if (!run.loginVerified && run.deferredUntil === undefined) await suspend(login);
  await runActions(watchId, viewerId);
  await refreshAvatarImage(watchId, viewerId, run);
  await notifyCheck(watchId, scope.checkId, startedAt);
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
  const exists = (job: { readonly watchId: string }) =>
    watches.some(watch => watch.id === job.watchId);
  const current: LoginSchedule = {
    ...(schedule ?? { nextRoundAt: now, remaining: [], earlyRetries: [] }),
    manual: schedule?.manual?.filter(exists),
    lastManual: schedule?.lastManual?.filter(exists),
  };
  const manual = current.manual?.[0];
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

const verifyViewer = (login: InstagramLogin) =>
  Effect.runPromise(fetchViewer.pipe(Effect.either, Effect.provide(WatchRequests(login))));

const hasDueWork = (state: SchedulerState, watches: readonly Watch[]) =>
  watches.some(
    watch =>
      nextJob(state.logins[watch.viewerId], [watch], Date.now()).job !== undefined ||
      actionsNeedWork(watch) ||
      notificationsNeedWork(watch)
  );

/**
 * The verified account of `login` when its Watch work may run now. The linked login runs only
 * while it is linked and its session has not ended, and only as the linked account.
 */
async function readyViewer(
  login: InstagramLogin,
  state: SchedulerState,
  watches: readonly Watch[],
  linkedId: string | undefined
): Promise<string | undefined> {
  if (state[SUSPENDED_KEYS[login]]) return undefined;
  const owned = watches.filter(watch => runsAs(login, watch.viewerId, linkedId));
  if (!hasDueWork(state, owned)) return undefined;
  const viewer = await verifyViewer(login);
  if (viewer._tag === 'Left') {
    await viewerRefused(login, viewer.left._tag, linkedId);
    return undefined;
  }
  return runsAs(login, viewer.right.accountId, linkedId) ? viewer.right.accountId : undefined;
}

/**
 * Pacing defers `login`'s pending manual checks. Any other refusal suspends its Watches, except a
 * linked session Instagram ended, which the viewer read already recorded.
 */
async function viewerRefused(login: InstagramLogin, reason: string, linkedId: string | undefined) {
  if (reason === 'WatchRequestDeferred' || reason === 'RateLimited')
    await holdPendingManual(login, linkedId, Date.now());
  else if (reason !== 'ViewerMissing' || login === 'main') await suspend(login);
}

/** The logins that may run Watch work: the linked one only while linked and not ended. */
async function activeLogins() {
  const linked = linkedLoginSupported() ? await readLinkedLogin() : undefined;
  const logins: InstagramLogin[] = linked && !linked.ended ? ['main', 'linked'] : ['main'];
  return { logins, linkedId: linked?.accountId };
}

/** Every login whose Watch work may run now, with its verified account. */
async function readyLogins(): Promise<{ login: InstagramLogin; viewerId: string }[]> {
  const state = await loadState();
  const read = await readStore();
  if ((state.startupHoldUntil ?? 0) > Date.now() || read.kind === 'failed') return [];
  const { logins, linkedId } = await activeLogins();
  const ready: { login: InstagramLogin; viewerId: string }[] = [];
  for (const login of logins) {
    const viewerId = await readyViewer(login, state, read.store.watches, linkedId);
    if (viewerId) ready.push({ login, viewerId });
  }
  return ready;
}

/**
 * Pacing held `login`'s pump back before any job ran: its pending manual checks wait for the same
 * hold. The linked login's schedule is the linked account's; the main login's is any other.
 */
async function holdPendingManual(login: InstagramLogin, linkedId: string | undefined, now: number) {
  const until = ledgerOf(login).nextWatchAllowedAt(now);
  const ownsSchedule = (viewerId: string) => runsAs(login, viewerId, linkedId);
  const state = await loadState();
  if (
    until <= now ||
    !Object.entries(state.logins).some(
      ([viewerId, schedule]) => ownsSchedule(viewerId) && schedule.manual?.length
    )
  )
    return;
  const deferredReason = pacingReason(login, now);
  await updateState(current => ({
    ...current,
    logins: Object.fromEntries(
      Object.entries(current.logins).map(([viewerId, schedule]) => [
        viewerId,
        ownsSchedule(viewerId)
          ? {
              ...schedule,
              manual: schedule.manual?.map(job => ({
                ...job,
                deferredUntil: until,
                deferredReason,
              })),
            }
          : schedule,
      ])
    ),
  }));
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
    await finishManual(run.login, viewerId, job.watchId, job.checkId, [
      ...(job.outcomes ?? []),
      ...run.kinds,
    ]);
  else await deferManual(run.login, viewerId, job.watchId, job.checkId, run.deferredUntil);
  await refreshBadge();
  return run.loginVerified && run.deferredUntil === undefined;
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
  if (!run.loginVerified) return false;
  await setSchedule(viewerId, current => finishJob(current ?? schedule, job, failures, Date.now()));
  return true;
}

/**
 * Runs whatever Watch work is due for each verified login, checkpointing after every Watch so a
 * suspended worker resumes where it stopped. Throttling ends a login's run until the next wake.
 */
async function pumpOnce(deadline: number): Promise<void> {
  if (
    !(await initializeScheduler().then(
      () => true,
      () => false
    ))
  )
    return;
  for (const { viewerId } of await readyLogins()) {
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

/**
 * After an update, books an early retry due now for every kind whose check problem the older
 * version recorded from an answer it could not read, so a successful check clears it.
 */
export async function retryAfterUpdate(): Promise<void> {
  const read = await readStore();
  if (read.kind === 'failed') return;
  const now = Date.now();
  for (const watch of read.store.watches) {
    if (!watch.enabled) continue;
    const kinds = watch.kinds.filter(kind => {
      const code = watch.tracking[kind]?.problem?.code;
      return code !== undefined && ANSWER_FAILURES.has(code);
    });
    if (kinds.length === 0) continue;
    await setSchedule(watch.viewerId, current => {
      const schedule = current ?? { nextRoundAt: now, remaining: [], earlyRetries: [] };
      const others = schedule.earlyRetries.filter(
        retry => retry.watchId !== watch.id || !kinds.includes(retry.kind)
      );
      const booked = kinds.map(kind => ({ watchId: watch.id, kind, at: now }));
      return { ...schedule, earlyRetries: [...others, ...booked] };
    });
  }
}

/** A person verified `login` again, so its suspended Watches may run. */
export async function resumeAfterPerson(login: InstagramLogin): Promise<void> {
  const key = SUSPENDED_KEYS[login];
  const state = await loadState();
  if (state[key]) await updateState(current => ({ ...current, [key]: undefined }));
}

/** The verified login's schedule, and where each of its Watches' manual check stands. */
export async function scheduleOf(viewerId: string) {
  const state = await loadState();
  const login = await loginOf(viewerId);
  const ledger = ledgerOf(login);
  await ledger.ready();
  return {
    schedule: watchSchedule(state, ledger.view, viewerId, Date.now(), login),
    manualChecks: manualChecks(state.logins[viewerId]),
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

type ManualJob = NonNullable<LoginSchedule['manual']>[number];

/** Replaces one manual job of the login through `change`. */
const updateManual = (
  viewerId: string,
  watchId: string,
  checkId: string,
  change: (job: ManualJob) => ManualJob
) =>
  updateState(state => {
    const current = state.logins[viewerId];
    if (!current) return state;
    return {
      ...state,
      logins: {
        ...state.logins,
        [viewerId]: {
          ...current,
          manual: current.manual?.map(job =>
            job.watchId === watchId && job.checkId === checkId ? change(job) : job
          ),
        },
      },
    };
  }, true);

export async function checkpointManual(
  viewerId: string,
  watchId: string,
  checkId: string,
  outcome: import('@gramgrab/protocol').KindCheckOutcome
) {
  if (outcome._tag === 'KindCheckSkipped' && outcome.reason === 'deferred') return;
  await updateManual(viewerId, watchId, checkId, job => ({
    watchId: job.watchId,
    checkId: job.checkId,
    remainingKinds: job.remainingKinds.filter(kind => kind !== outcome.kind),
    outcomes: [...(job.outcomes ?? []).filter(previous => previous.kind !== outcome.kind), outcome],
  }));
}

/** Why pacing holds `login`'s Watch work back right now: a rate-limit pause, or ordinary spacing. */
export const pacingReason = (login: InstagramLogin, now: number): DeferredReason =>
  ledgerOf(login).pausedUntil(now) === undefined ? 'paced' : 'rate-limited';

/** Records that pacing stopped a manual check part way, and until when. */
export async function deferManual(
  login: InstagramLogin,
  viewerId: string,
  watchId: string,
  checkId: string,
  until: number
) {
  const reason = pacingReason(login, Date.now());
  await updateManual(viewerId, watchId, checkId, job => ({
    ...job,
    deferredUntil: until,
    deferredReason: reason,
  }));
}

/** Records a finished manual check of `login`'s Watch, suspending that login if it was refused. */
export async function finishManual(
  login: InstagramLogin,
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
  if (checkNeedsLogin(outcomes)) await suspend(login);
  await setSchedule(viewerId, current => ({
    ...(current ?? { nextRoundAt: Date.now(), remaining: [], earlyRetries: [] }),
    manual: current?.manual?.filter(job => job.watchId !== watchId || job.checkId !== checkId),
    lastManual: [
      ...(current?.lastManual ?? []).filter(last => last.watchId !== watchId),
      { watchId, finishedAt: Date.now(), outcomes },
    ],
    earlyRetries: [
      ...(current?.earlyRetries ?? []).filter(
        retry => retry.watchId !== watchId || !completed.has(retry.kind)
      ),
      ...failures,
    ],
  }));
}
