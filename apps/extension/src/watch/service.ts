import { Data, Effect, Schema } from 'effect';
import {
  AccountId,
  CommandFailure,
  ExistingWatch,
  OperationFailure,
  StoredWatchCount,
  UNATTENDED_DISCLOSURE,
  UnattendedDisclosure,
  WatchAddResult,
  WatchCheckOutcome,
  WatchCheckResult,
  WatchInboxListResult,
  WatchInboxRemoveResult,
  WatchLifecycleResult,
  WatchListResult,
  WatchSchedule,
  WatchSetResult,
  WatchShowResult,
  WatchStorage,
  WatchViewer,
  type FailureCode,
  type WatchCommand,
  type WatchFailureDetail,
  type WatchResult,
  type WatchSelector,
} from '@gramgrab/protocol';
import { canonicalizeInstagramUrl } from '../workspace/contracts.ts';
import { resolveUsernameToId } from '../instagram/acquisition.ts';
import { PersonRequests, requestLedger, type InstagramRequests } from '../instagram/requests.ts';
import { normalizeSourceFailure } from '../errors/normalize.ts';
import type { WatchCommandResponse, WatchPreviewResponse } from '../messaging/contracts.ts';
import { STORE_BUDGET_BYTES, type Watch, type WatchStore } from './contracts.ts';
import { loginAttention, refreshBadge, rememberViewer } from './attention.ts';
import { MANUAL_CHECK_INTERVAL_MS, lastCheckAt } from './check.ts';
import { discoveries, inbox, initialized, summarize } from './summary.ts';
import { resumeAfterPerson, runCheck, scheduleOf } from './scheduler.ts';
import { confirmProfile, fetchViewer, type Account } from './identity.ts';
import {
  mutateStore,
  readStore,
  storeHealth,
  type StoreFailureCode,
  type StoreRead,
} from './store.ts';

/** A Watch command the background refuses, with the context that makes it actionable. */
class WatchRejection extends Data.TaggedError('WatchRejection')<{
  readonly code: FailureCode;
  readonly detail?: WatchFailureDetail;
}> {}

const reject = (code: FailureCode, detail?: WatchFailureDetail) =>
  Effect.fail(new WatchRejection({ code, ...(detail ? { detail } : {}) }));

const decodeUuid = Schema.decodeUnknownSync(Schema.UUID);

const load = Effect.promise(readStore);

const loadOrReject = Effect.flatMap(load, read =>
  read.kind === 'ok' ? Effect.succeed(read.store) : reject(read.code)
);

const save = <T>(change: (store: WatchStore) => { store: WatchStore; value: T }) =>
  Effect.flatMap(
    Effect.promise(() => mutateStore(change)),
    write => (write.kind === 'ok' ? Effect.succeed(write.value) : reject(write.code))
  );

/**
 * Verifies the signed-in viewer before any owner-bound work. Without a verified viewer, the only
 * Watch state anyone sees is how many Watches are stored.
 */
const verifyViewer = (store: WatchStore | undefined) =>
  fetchViewer.pipe(
    Effect.tap(viewer =>
      Effect.promise(() => Promise.all([rememberViewer(viewer.accountId), resumeAfterPerson()]))
    ),
    Effect.catchAll(() =>
      reject('IG_NOT_AUTHENTICATED', StoredWatchCount.make({ count: store?.watches.length ?? 0 }))
    )
  );

const owned = (store: WatchStore, viewer: Account) =>
  store.watches.filter(watch => watch.viewerId === viewer.accountId);

const matches = (watch: Watch, selector: WatchSelector) =>
  selector._tag === 'AccountIdSelector'
    ? watch.targetId === selector.accountId
    : watch.username.toLowerCase() === selector.username.toLowerCase();

const selectorText = (selector: WatchSelector) =>
  selector._tag === 'AccountIdSelector' ? selector.accountId : selector.username;

const STORAGE_STATUS = {
  WATCH_STORE_CAPACITY_EXCEEDED: 'full',
  WATCH_STORE_FAILED: 'write-failed',
  WATCH_STORE_UNREADABLE: 'unreadable',
  WATCH_STORE_VERSION_UNSUPPORTED: 'unsupported',
} as const satisfies Record<StoreFailureCode, WatchStorage['status']>;

/** How full the store is, and the problem that stopped Watches if one did. */
async function storageState(read: StoreRead): Promise<WatchStorage> {
  if (read.kind === 'failed')
    return WatchStorage.make({
      usedBytes: 0,
      budgetBytes: STORE_BUDGET_BYTES,
      status: STORAGE_STATUS[read.code],
    });
  const health = await storeHealth();
  return WatchStorage.make({
    usedBytes: read.bytes,
    budgetBytes: STORE_BUDGET_BYTES,
    status: health ? STORAGE_STATUS[health.code] : 'ok',
  });
}

const list = Effect.gen(function* () {
  const read = yield* load;
  const store = read.kind === 'ok' ? read.store : undefined;
  const viewer = yield* verifyViewer(store);
  const storage = yield* Effect.promise(() => storageState(read));
  const watches = store ? owned(store, viewer).map(watch => summarize(watch)) : [];
  const schedule = yield* Effect.promise(() => scheduleOf(viewer.accountId));
  yield* Effect.promise(() => requestLedger.ready());
  const pause = requestLedger.pause;
  return WatchListResult.make({
    viewer: WatchViewer.make(viewer),
    schedule: WatchSchedule.make({
      ...(schedule.nextRoundAt === undefined ? {} : { nextRoundAt: schedule.nextRoundAt }),
      roundRemaining: schedule.roundRemaining,
      ...(pause ? { pausedUntil: pause.until } : {}),
      suspended: schedule.suspended,
    }),
    otherLoginWatchCount: (store?.watches.length ?? 0) - watches.length,
    storage,
    attentionCount:
      (store ? (yield* Effect.promise(() => loginAttention(store, viewer.accountId))).length : 0) +
      (storage.status === 'ok' ? 0 : 1),
    watches,
  });
});

const findOwned = (store: WatchStore, viewer: Account, selector: WatchSelector) =>
  Effect.fromNullable(owned(store, viewer).find(watch => matches(watch, selector))).pipe(
    Effect.orElse(() => reject('WATCH_NOT_FOUND'))
  );

/** Reads the username a person typed or the one in a profile URL. */
function targetUsername(target: string): string | undefined {
  const trimmed = target.trim().replace(/^@/, '');
  if (/^[A-Za-z0-9._]{1,30}$/.test(trimmed)) return trimmed;
  const parsed = canonicalizeInstagramUrl(trimmed)?.target;
  return parsed?.type === 'profile' ? parsed.username : undefined;
}

/** Resolves a typed target to the account it names, confirmed through its stable ID. */
const resolveTarget = (target: string) =>
  Effect.gen(function* () {
    const username = targetUsername(target);
    if (!username) return yield* reject('INPUT_INVALID_SOURCE_URL');
    const accountId = yield* resolveUsernameToId(username).pipe(
      Effect.catchAll(error =>
        error._tag === 'WatchRequestDeferred'
          ? reject('SOURCE_UNEXPECTED_FAILURE')
          : reject(normalizeSourceFailure(error).code)
      )
    );
    if (!accountId || !Schema.is(AccountId)(accountId))
      return yield* reject('SOURCE_USERNAME_UNRESOLVED');
    return yield* confirmProfile(accountId).pipe(
      Effect.catchAll(error => {
        if (error._tag === 'UsernameUnconfirmed') return reject('WATCH_USERNAME_UNCONFIRMED');
        if (error._tag === 'WatchRequestDeferred') return reject('SOURCE_UNEXPECTED_FAILURE');
        return reject(normalizeSourceFailure(error).code);
      })
    );
  });

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every(value => right.includes(value));

const add = (command: Extract<WatchCommand, { _tag: 'WatchAdd' }>) =>
  Effect.gen(function* () {
    if (!command.acceptUnattended)
      return yield* reject(
        'WATCH_UNATTENDED_NOT_ACCEPTED',
        UnattendedDisclosure.make({ text: UNATTENDED_DISCLOSURE })
      );
    const viewer = yield* verifyViewer(yield* loadOrReject);
    const target = yield* resolveTarget(command.target);
    return yield* save<{
      readonly _tag: 'created' | 'existing' | 'conflict';
      readonly watch: Watch;
    }>(store => {
      const existing = owned(store, viewer).find(watch => watch.targetId === target.accountId);
      if (existing)
        return {
          store,
          value:
            sameSet(existing.kinds, command.kinds) && sameSet(existing.actions, command.actions)
              ? { _tag: 'existing', watch: existing }
              : { _tag: 'conflict', watch: existing },
        };
      const watch: Watch = {
        id: decodeUuid(crypto.randomUUID()),
        viewerId: viewer.accountId,
        targetId: target.accountId,
        username: target.username,
        createdAt: Date.now(),
        enabled: true,
        kinds: command.kinds,
        actions: command.actions,
        tracking: {},
        discoveries: [],
      };
      return {
        store: { ...store, watches: [...store.watches, watch] },
        value: { _tag: 'created', watch },
      };
    }).pipe(
      Effect.flatMap(outcome =>
        outcome._tag === 'conflict'
          ? reject(
              'WATCH_CONFIG_CONFLICT',
              ExistingWatch.make({
                accountId: outcome.watch.targetId,
                username: outcome.watch.username,
              })
            )
          : Effect.succeed(
              WatchAddResult.make({
                created: outcome._tag === 'created',
                watch: summarize(outcome.watch),
              })
            )
      )
    );
  });

/** Replaces one owned Watch through `change`, failing if it disappeared meanwhile. */
const updateWatch = <T>(
  viewer: Account,
  selector: WatchSelector,
  change: (watch: Watch) => { watch: Watch; value: T }
) =>
  save(store => {
    const current = owned(store, viewer).find(watch => matches(watch, selector));
    if (!current) return { store, value: undefined };
    const next = change(current);
    return {
      store: {
        ...store,
        watches: store.watches.map(watch => (watch.id === current.id ? next.watch : watch)),
      },
      value: next,
    };
  }).pipe(Effect.flatMap(result => (result ? Effect.succeed(result) : reject('WATCH_NOT_FOUND'))));

const set = (command: Extract<WatchCommand, { _tag: 'WatchSet' }>) =>
  Effect.gen(function* () {
    const viewer = yield* verifyViewer(yield* loadOrReject);
    const { watch, value: baselineKinds } = yield* updateWatch(viewer, command.watch, watch => {
      const kinds = command.kinds ?? watch.kinds;
      return {
        watch: { ...watch, kinds, actions: command.actions ?? watch.actions },
        value: kinds.filter(kind => !watch.kinds.includes(kind) && !initialized(watch, kind)),
      };
    });
    return WatchSetResult.make({ watch: summarize(watch), baselineKinds });
  });

const lifecycle = (command: Extract<WatchCommand, { _tag: 'WatchLifecycle' }>) =>
  Effect.gen(function* () {
    const viewer = yield* verifyViewer(yield* loadOrReject);
    return yield* save(store => {
      const mine = owned(store, viewer);
      const selected = new Map<string, Watch>();
      const unknownWatches: string[] = [];
      for (const selector of command.watches) {
        const watch = mine.find(candidate => matches(candidate, selector));
        if (watch) selected.set(watch.id, watch);
        else unknownWatches.push(selectorText(selector));
      }
      const changed = [...selected.values()].map(watch =>
        command.operation === 'delete'
          ? watch
          : { ...watch, enabled: command.operation === 'resume' }
      );
      const watches =
        command.operation === 'delete'
          ? store.watches.filter(watch => !selected.has(watch.id))
          : store.watches.map(watch => changed.find(next => next.id === watch.id) ?? watch);
      return {
        store: selected.size === 0 ? store : { ...store, watches },
        value: WatchLifecycleResult.make({
          operation: command.operation,
          watches: changed.map(watch => summarize(watch)),
          unknownWatches,
        }),
      };
    });
  });

/** Runs one manual check, unless the Watch was checked moments ago. */
const checkOne = (watch: Watch, viewer: Account, checkId: string) =>
  Effect.gen(function* () {
    const last = lastCheckAt(watch);
    const earliest = last === undefined ? 0 : last + MANUAL_CHECK_INTERVAL_MS;
    const run =
      earliest > Date.now()
        ? { kinds: [], deferredUntil: earliest }
        : yield* Effect.promise(() => runCheck(watch.id, viewer.accountId, checkId));
    return WatchCheckOutcome.make({
      watchId: watch.id,
      accountId: watch.targetId,
      username: watch.username,
      kinds: run.kinds,
      ...(run.deferredUntil === undefined ? {} : { deferredUntil: run.deferredUntil }),
    });
  });

const check = (command: Extract<WatchCommand, { _tag: 'WatchCheck' }>) =>
  Effect.gen(function* () {
    const store = yield* loadOrReject;
    const viewer = yield* verifyViewer(store);
    const mine = owned(store, viewer);
    const selected = command.watches
      ? command.watches.map(selector => ({
          selector,
          watch: mine.find(watch => matches(watch, selector)),
        }))
      : mine.filter(watch => watch.enabled).map(watch => ({ selector: undefined, watch }));
    const outcomes: WatchCheckOutcome[] = [];
    const checkId = decodeUuid(crypto.randomUUID());
    for (const { watch } of selected)
      if (watch) outcomes.push(yield* checkOne(watch, viewer, checkId));
    return WatchCheckResult.make({
      outcomes,
      unknownWatches: selected.flatMap(({ selector, watch }) =>
        !watch && selector ? [selectorText(selector)] : []
      ),
    });
  });

const inboxList = (command: Extract<WatchCommand, { _tag: 'WatchInboxList' }>) =>
  Effect.gen(function* () {
    const store = yield* loadOrReject;
    const viewer = yield* verifyViewer(store);
    const watches = command.watch
      ? [yield* findOwned(store, viewer, command.watch)]
      : owned(store, viewer);
    return WatchInboxListResult.make({
      entries: watches
        .flatMap(watch => inbox(watch))
        .sort((left, right) => right.discoveredAt - left.discoveredAt),
    });
  });

/** Takes entries out of the inbox. The discovery stays, so its media is never found again. */
const inboxRemove = (command: Extract<WatchCommand, { _tag: 'WatchInboxRemove' }>) =>
  Effect.gen(function* () {
    const viewer = yield* verifyViewer(yield* loadOrReject);
    return yield* save(store => {
      const now = Date.now();
      const removable = new Set(
        owned(store, viewer).flatMap(watch => inbox(watch, now).map(entry => entry.entryId))
      );
      const removedEntryIds = command.entryIds.filter(id => removable.has(id));
      const watches = store.watches.map(watch => ({
        ...watch,
        discoveries: watch.discoveries.map(discovery =>
          discovery.collect && removedEntryIds.includes(discovery.id)
            ? { ...discovery, collect: { ...discovery.collect, removedAt: now } }
            : discovery
        ),
      }));
      return {
        store: removedEntryIds.length > 0 ? { ...store, watches } : store,
        value: WatchInboxRemoveResult.make({
          removedEntryIds,
          unknownEntryIds: command.entryIds.filter(id => !removable.has(id)),
        }),
      };
    });
  });

const program = (
  command: WatchCommand
): Effect.Effect<WatchResult, WatchRejection, InstagramRequests> => {
  switch (command._tag) {
    case 'WatchList':
      return list;
    case 'WatchShow':
      return Effect.gen(function* () {
        const store = yield* loadOrReject;
        const viewer = yield* verifyViewer(store);
        const watch = yield* findOwned(store, viewer, command.watch);
        return WatchShowResult.make({
          watch: summarize(watch),
          discoveries: discoveries(watch),
        });
      });
    case 'WatchAdd':
      return add(command);
    case 'WatchSet':
      return set(command);
    case 'WatchLifecycle':
      return lifecycle(command);
    case 'WatchCheck':
      return check(command);
    case 'WatchInboxList':
      return inboxList(command);
    case 'WatchInboxRemove':
      return inboxRemove(command);
  }
};

/** Runs person-initiated Watch work, answering a rejection as its protocol failure. */
const runForPerson = <A>(
  effect: Effect.Effect<A, WatchRejection, InstagramRequests>
): Promise<A | { readonly failure: CommandFailure }> =>
  Effect.runPromise(
    effect.pipe(
      Effect.catchAll(rejection =>
        Effect.succeed({
          failure: CommandFailure.make({
            failure: OperationFailure.make({ code: rejection.code, scope: 'batch' }),
            ...(rejection.detail ? { detail: rejection.detail } : {}),
          }),
        })
      ),
      Effect.provide(PersonRequests),
      Effect.ensuring(Effect.promise(refreshBadge))
    )
  );

/** Runs one Watch command, as the options page and CLI both do. */
export const runWatchCommand = (command: WatchCommand): Promise<WatchCommandResponse> =>
  runForPerson(Effect.map(program(command), result => ({ result })));

/** Resolves an add target for the person to inspect before adding it. */
export const previewWatchTarget = (target: string): Promise<WatchPreviewResponse> =>
  runForPerson(
    Effect.gen(function* () {
      const store = yield* loadOrReject;
      const viewer = yield* verifyViewer(store);
      const account = yield* resolveTarget(target);
      const existing = owned(store, viewer).find(watch => watch.targetId === account.accountId);
      return { account, ...(existing ? { existing: summarize(existing) } : {}) };
    })
  );
