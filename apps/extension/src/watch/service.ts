import { Data, Effect, Either, Match, Schema } from 'effect';
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
  WatchCheckProgress,
  WATCH_KINDS,
  KindCheckSkipped,
  WatchCheckResult,
  WatchInboxExportResult,
  WatchInboxListResult,
  type InboxExportOutcome,
  WatchInboxRemoveResult,
  WatchRecoverResult,
  WatchLifecycleResult,
  WatchListResult,
  WatchNeedsResult,
  WatchAttentionRecoverResult,
  PauseAttention,
  StorageAttention,
  WatchRecover,
  RecoveryOutcome,
  type WatchAttention,
  type AttentionOperation,
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
import { loginAttention, refreshBadge, rememberViewer, watchAttentionItems } from './attention.ts';
import { MANUAL_CHECK_INTERVAL_MS, lastCheckAt } from './check.ts';
import { attentionEntries, discoveries, inbox, initialized, summarize } from './summary.ts';
import { retryNotify } from './notify.ts';
import { inInbox } from './discoveries.ts';
import { finishActions } from './auto-download.ts';
import { recoverable, applyRecovery, recoveryOutcome } from './recovery.ts';
import type { Learned } from './export.ts';
import { exportPlannedEntry } from './manual-export-run.ts';
import { InboxExportExecution } from './manual-export.ts';
import {
  resumeAfterPerson,
  runCheck,
  scheduleOf,
  queueManual,
  checkpointManual,
  finishManual,
} from './scheduler.ts';
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
  const pausedUntil = requestLedger.pausedUntil(Date.now());
  return WatchListResult.make({
    viewer: WatchViewer.make(viewer),
    schedule: WatchSchedule.make({
      ...(schedule.nextRoundAt === undefined ? {} : { nextRoundAt: schedule.nextRoundAt }),
      roundRemaining: schedule.roundRemaining,
      ...(pausedUntil ? { pausedUntil } : {}),
      suspended: schedule.suspended,
    }),
    otherLoginWatchCount: (store?.watches.length ?? 0) - watches.length,
    storage,
    attentionCount:
      (store ? (yield* Effect.promise(() => loginAttention(store, viewer.accountId))).length : 0) +
      (storage.status === 'ok' ? 0 : 1),
    watches,
    attentionEntries: store ? owned(store, viewer).flatMap(watch => attentionEntries(watch)) : [],
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

function deferredUntil(watch: Watch, now: number): number | undefined {
  const last = lastCheckAt(watch);
  const manual = last === undefined ? now : last + MANUAL_CHECK_INTERVAL_MS;
  const paced = requestLedger.nextWatchAllowedAt(now);
  return manual > now || paced > now + 25_000 ? Math.max(manual, paced) : undefined;
}

const checkOne = Effect.fn(function* (
  watch: Watch,
  viewer: Account,
  checkId: string,
  onProgress: (progress: WatchCheckProgress) => void
) {
  const publish = (outcome: import('@gramgrab/protocol').KindCheckOutcome) =>
    onProgress(WatchCheckProgress.make({ watchId: watch.id, kind: outcome.kind, outcome }));
  const off = WATCH_KINDS.filter(kind => !watch.kinds.includes(kind)).map(kind =>
    KindCheckSkipped.make({ kind, reason: 'kind-off' })
  );
  for (const outcome of off) publish(outcome);
  const run = yield* Effect.tryPromise({
    try: () =>
      runCheck(watch.id, viewer.accountId, {
        checkId,
        feedScope: checkId,
        onKind: async outcome => {
          await checkpointManual(viewer.accountId, watch.id, checkId, outcome);
          publish(outcome);
        },
      }),
    catch: () => new WatchRejection({ code: 'WATCH_STORE_FAILED' }),
  });
  if (run.deferredUntil === undefined)
    yield* Effect.promise(() => finishManual(viewer.accountId, watch.id, checkId, run.kinds));
  return WatchCheckOutcome.make({
    watchId: watch.id,
    accountId: watch.targetId,
    username: watch.username,
    kinds: [...off, ...run.kinds],
    ...(run.deferredUntil === undefined ? {} : { deferredUntil: run.deferredUntil }),
  });
});

const check = (
  command: Extract<WatchCommand, { _tag: 'WatchCheck' }>,
  onProgress: (progress: WatchCheckProgress) => void
) =>
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
    const unique = [
      ...new Map(
        selected.flatMap(({ watch }) => (watch ? [[watch.id, watch] as const] : []))
      ).values(),
    ];
    const holds = new Map(unique.map(watch => [watch.id, deferredUntil(watch, Date.now())]));
    const admitted = unique.filter(watch => holds.get(watch.id) === undefined);
    const checkId = decodeUuid(crypto.randomUUID());
    const queued = yield* Effect.tryPromise({
      try: () => queueManual(viewer.accountId, checkId, admitted),
      catch: () => new WatchRejection({ code: 'WATCH_STORE_FAILED' }),
    }).pipe(Effect.either);
    const outcomes = yield* Effect.forEach(unique, watch => {
      const until =
        holds.get(watch.id) ??
        (Either.isRight(queued) && !queued.right.watchIds.has(watch.id)
          ? Math.max(requestLedger.nextWatchAllowedAt(Date.now()), Date.now() + 1_000)
          : undefined);
      return until === undefined
        ? Either.isRight(queued)
          ? checkOne(watch, viewer, checkId, onProgress)
          : Effect.succeed(
              WatchCheckOutcome.make({
                watchId: watch.id,
                accountId: watch.targetId,
                username: watch.username,
                kinds: watch.kinds.map(kind => KindCheckSkipped.make({ kind, reason: 'storage' })),
              })
            )
        : Effect.succeed(
            WatchCheckOutcome.make({
              watchId: watch.id,
              accountId: watch.targetId,
              username: watch.username,
              kinds: [],
              deferredUntil: until,
            })
          );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (Either.isRight(queued)) queued.right.release();
        })
      )
    );
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
          discovery.collect &&
          !('status' in discovery.collect) &&
          removedEntryIds.includes(discovery.id)
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

/**
 * Exports each selected inbox entry's exact media with its frozen settings, in the order given. One entry's
 * failure never stops the others, and every entry stays in the inbox. What an Export shows to be
 * gone is kept, so the entry cannot be selected again.
 */
const inboxExport = (
  command: Extract<WatchCommand, { _tag: 'WatchInboxExport' | 'WatchInboxRetry' }>
) =>
  Effect.gen(function* () {
    const store = yield* loadOrReject;
    const viewer = yield* verifyViewer(store);
    const now = Date.now();
    const entries = new Map(
      owned(store, viewer).flatMap(watch =>
        watch.discoveries
          .filter(discovery => inInbox(discovery, now))
          .map(discovery => [discovery.id, { watch, discovery }] as const)
      )
    );
    const selected = [
      ...new Set(
        command._tag === 'WatchInboxExport'
          ? command.entryIds
          : command.plans.map(plan => plan.entryId)
      ),
    ];
    const outcomes: InboxExportOutcome[] = [];
    const learned = new Map<string, Learned>();
    for (const id of selected) {
      const entry = entries.get(id);
      if (!entry) continue;
      const result = yield* exportPlannedEntry(entry.watch, entry.discovery, command);
      outcomes.push(result.outcome);
      if (result.learned) learned.set(id, result.learned);
    }
    if (learned.size > 0)
      yield* Effect.promise(() =>
        mutateStore(current => ({
          store: {
            ...current,
            watches: current.watches.map(watch => ({
              ...watch,
              discoveries: watch.discoveries.map(discovery => ({
                ...discovery,
                ...learned.get(discovery.id),
              })),
            })),
          },
          value: undefined,
        }))
      );
    return WatchInboxExportResult.make({
      outcomes,
      unknownEntryIds: selected.filter(id => !entries.has(id)),
    });
  });

/**
 * Recovers only the selected failed action or uncertain children, preserving accepted work.
 */
const recover = (command: Extract<WatchCommand, { _tag: 'WatchRecover' }>) =>
  Effect.gen(function* () {
    const viewer = yield* verifyViewer(yield* loadOrReject);
    const result = yield* save(store => {
      const entries = new Map(
        owned(store, viewer).flatMap(watch =>
          watch.discoveries.map(discovery => [discovery.id, { watch, discovery }] as const)
        )
      );
      const known = command.entryIds.filter(id => entries.has(id));
      const recovered = known.filter(id => {
        const entry = entries.get(id)!;
        return entry.watch.enabled && recoverable(entry.discovery, command);
      });
      const watches = store.watches.map(watch => ({
        ...watch,
        discoveries: watch.discoveries.map(discovery => {
          if (!recovered.includes(discovery.id)) return discovery;
          return applyRecovery(discovery, command);
        }),
      }));
      return {
        store: recovered.length > 0 ? { ...store, watches } : store,
        value: {
          before: recovered.map(id => entries.get(id)!.discovery),
          retried: recovered.map(id => ({ watchId: entries.get(id)!.watch.id, entryId: id })),
          result: WatchRecoverResult.make({
            recoveredEntryIds: recovered,
            refused: known
              .filter(id => !recovered.includes(id))
              .map(entryId => ({ entryId, code: 'WATCH_RECOVERY_NOT_APPLICABLE' as const })),
            unknownEntryIds: command.entryIds.filter(id => !entries.has(id)),
          }),
        },
      };
    });
    if (command.action === 'notify' && command.operation === 'retry')
      yield* Effect.promise(() => retryNotify(result.retried));
    if (
      command.action !== 'notify' &&
      (command.operation === 'retry' || command.operation === 'download-again')
    ) {
      const read = yield* loadOrReject;
      const ids = new Set(result.retried.map(entry => entry.watchId));
      for (const watch of owned(read, viewer)) if (ids.has(watch.id)) yield* finishActions(watch);
    }
    yield* Effect.promise(refreshBadge);
    const after = yield* loadOrReject;
    const entries = new Map(
      owned(after, viewer).flatMap(watch =>
        discoveries(watch).map(entry => [entry.entryId, entry] as const)
      )
    );
    const outcomes = result.before.map(before =>
      recoveryOutcome(before, entries.get(before.id), command)
    );
    return WatchRecoverResult.make({
      refused: result.result.refused,
      unknownEntryIds: result.result.unknownEntryIds,
      recoveredEntryIds: outcomes
        .filter(outcome => outcome.state === 'recovered')
        .map(outcome => outcome.entryId),
      outcomes,
    });
  });

const NEEDS_STORAGE_CODE = {
  full: 'WATCH_STORE_CAPACITY_EXCEEDED',
  'write-failed': 'WATCH_STORE_FAILED',
  unreadable: 'WATCH_STORE_UNREADABLE',
  unsupported: 'WATCH_STORE_VERSION_UNSUPPORTED',
} as const;

const needs = Effect.gen(function* () {
  const snapshot = yield* list;
  const read = yield* load;
  const items =
    read.kind === 'ok'
      ? read.store.watches
          .filter(watch => watch.viewerId === snapshot.viewer.accountId)
          .flatMap(watchAttentionItems)
      : [];
  if (snapshot.schedule.pausedUntil && snapshot.watches.length)
    items.unshift(
      PauseAttention.make({
        attentionId: `pause.${snapshot.viewer.accountId}`,
        until: snapshot.schedule.pausedUntil,
        code: 'IG_RATE_LIMITED',
      })
    );
  if (snapshot.storage.status !== 'ok')
    items.unshift(
      StorageAttention.make({
        attentionId: 'storage',
        code: NEEDS_STORAGE_CODE[snapshot.storage.status],
      })
    );
  return WatchNeedsResult.make({
    items,
    watches: snapshot.watches,
    entries: snapshot.attentionEntries,
  });
});

const recoverAttention = Effect.fn(function* (
  item: WatchAttention | undefined,
  attentionId: string,
  operation: AttentionOperation
) {
  if (!item) return { state: 'unknown' as const, attentionId };
  if (item._tag !== 'ActionAttention' || !item.operations.includes(operation))
    return { state: 'refused' as const, attentionId };
  const result = yield* recover(
    WatchRecover.make({
      operation,
      action: item.action,
      entryIds: [item.entryId],
      ...(item.child === undefined ? {} : { child: item.child }),
    })
  ).pipe(Effect.either);
  if (Either.isLeft(result))
    return {
      state: 'failed' as const,
      attentionId,
      outcome: RecoveryOutcome.make({
        entryId: item.entryId,
        state: 'failed',
        code: result.left.code,
      }),
    };
  return attentionRecoveryResult(result.right, item, attentionId);
});

function attentionRecoveryResult(
  result: WatchRecoverResult,
  item: Extract<WatchAttention, { _tag: 'ActionAttention' }>,
  attentionId: string
) {
  if (result.unknownEntryIds.length) return { state: 'unknown' as const, attentionId };
  if (result.refused.length) return { state: 'refused' as const, attentionId };
  const outcome =
    result.outcomes?.[0] ?? RecoveryOutcome.make({ entryId: item.entryId, state: 'waiting' });
  return outcome.state === 'recovered'
    ? { state: 'recovered' as const, attentionId }
    : { state: 'failed' as const, attentionId, outcome };
}

const attentionRecover = (command: Extract<WatchCommand, { _tag: 'WatchAttentionRecover' }>) =>
  Effect.gen(function* () {
    const snapshot = yield* needs;
    const items = new Map(snapshot.items.map(item => [item.attentionId, item] as const));
    const outcomes = yield* Effect.forEach([...new Set(command.attentionIds)], attentionId =>
      recoverAttention(items.get(attentionId), attentionId, command.operation)
    );
    return WatchAttentionRecoverResult.make({
      recoveredAttentionIds: outcomes.flatMap(outcome =>
        outcome.state === 'recovered' ? [outcome.attentionId] : []
      ),
      unknownAttentionIds: outcomes.flatMap(outcome =>
        outcome.state === 'unknown' ? [outcome.attentionId] : []
      ),
      refused: outcomes.flatMap(outcome =>
        outcome.state === 'refused'
          ? [{ attentionId: outcome.attentionId, code: 'WATCH_RECOVERY_NOT_APPLICABLE' as const }]
          : []
      ),
      failures: outcomes.flatMap(outcome =>
        outcome.state === 'failed'
          ? [{ attentionId: outcome.attentionId, outcome: outcome.outcome }]
          : []
      ),
    });
  });

const show = (command: Extract<WatchCommand, { _tag: 'WatchShow' }>) =>
  Effect.gen(function* () {
    const store = yield* loadOrReject;
    const viewer = yield* verifyViewer(store);
    const watch = yield* findOwned(store, viewer, command.watch);
    return WatchShowResult.make({ watch: summarize(watch), discoveries: discoveries(watch) });
  });

const program = (
  command: WatchCommand,
  onProgress: (progress: WatchCheckProgress) => void
): Effect.Effect<WatchResult, WatchRejection, InstagramRequests | InboxExportExecution> =>
  Match.valueTags(command, {
    WatchList: () => list,
    WatchNeeds: () => needs,
    WatchAttentionRecover: attentionRecover,
    WatchShow: show,
    WatchAdd: add,
    WatchSet: set,
    WatchLifecycle: lifecycle,
    WatchCheck: command => check(command, onProgress),
    WatchInboxList: inboxList,
    WatchInboxRemove: inboxRemove,
    WatchInboxExport: inboxExport,
    WatchInboxRetry: inboxExport,
    WatchRecover: recover,
  });

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
export const runWatchCommand = (
  command: WatchCommand,
  run: InboxExportExecution['Type']['run'],
  onProgress: (progress: WatchCheckProgress) => void = () => {}
): Promise<WatchCommandResponse> =>
  runForPerson(
    Effect.map(program(command, onProgress), result => ({ result })).pipe(
      Effect.provideService(InboxExportExecution, { run })
    )
  );

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
