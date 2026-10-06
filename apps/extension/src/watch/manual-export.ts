import { Context, Effect } from 'effect';
import {
  DirectExport,
  InboxExportOutcome,
  type ExportResult,
  type ExportSettings,
  type FailureCode,
  type WatchCommand,
} from '@gramgrab/protocol';
import type { MessageOf } from '../messaging/contracts.ts';
import type { Discovery, ManualExportPlan, Watch } from './contracts.ts';
import { mutateStore } from './store.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';

type ExportChild = ManualExportPlan['children'][number];
export class InboxExportExecution extends Context.Tag('watch/InboxExportExecution')<
  InboxExportExecution,
  {
    readonly run: (request: Omit<MessageOf<'RUN_EXPORT'>, 'type'>) => Promise<ExportResult>;
  }
>() {}

type Fresh = Extract<WatchCommand, { _tag: 'WatchInboxExport' }>;
type Retry = Extract<WatchCommand, { _tag: 'WatchInboxRetry' }>;

function requestedChildren(
  discovery: Discovery,
  settings: ExportSettings
): readonly ExportSettings[] {
  const ref = discovery.ref;
  if (ref._tag === 'Avatar') return [{ mode: DirectExport.make() }];
  const types =
    ref._tag === 'Sidecar' ? ref.children.map(child => child.mediaType) : [ref.mediaType];
  return types.map(type => ({
    ...settings,
    mode: type === 'video' ? settings.mode : DirectExport.make(),
  }));
}

function recoveryApplies(child: ExportChild, recovery: Retry['recovery']) {
  if (child.state === 'pending') return !recovery;
  if (child.state !== 'failed' && child.state !== 'skipped') return false;
  if (child.state === 'skipped') return recovery !== undefined;
  if (!child.code || child.code === 'SILENT_REENCODE_DECLINED') return false;
  const policy = FAILURE_PRESENTATION[child.code];
  if (recovery === 'original') return policy.actions.includes('download-original');
  if (recovery === 'reencode') return policy.actions.includes('try-reencode');
  return policy.retry !== 'never';
}
function retryChild(child: ExportChild, recovery: Retry['recovery']): ExportChild {
  if (!recoveryApplies(child, recovery)) return child;
  const choice = recovery ?? child.recovery;
  return {
    operationId: child.operationId,
    requested: child.requested,
    ...(choice ? { recovery: choice } : {}),
    state: 'pending',
  };
}

export function requestedPlan(
  discovery: Discovery,
  command: Fresh | Retry
): ManualExportPlan | undefined {
  if (
    command._tag === 'WatchInboxExport' &&
    discovery.ref._tag === 'Avatar' &&
    command.settings &&
    (command.settings.mode._tag !== 'DirectExport' || command.settings.rotation)
  )
    return undefined;
  if (command._tag === 'WatchInboxExport')
    return {
      id: crypto.randomUUID(),
      children: requestedChildren(discovery, command.settings ?? { mode: DirectExport.make() }).map(
        requested => ({
          operationId: crypto.randomUUID(),
          requested,
          state: 'pending',
        })
      ),
    };
  const previous = discovery.manualExport;
  const requested = command.plans.find(plan => plan.entryId === discovery.id);
  if (!previous || previous.id !== requested?.planId) return undefined;
  const children = previous.children.map(child => retryChild(child, command.recovery));
  return children.some((child, index) => child !== previous.children[index])
    ? { ...previous, children }
    : undefined;
}

export function savePlan(watch: Watch, discovery: Discovery, plan: ManualExportPlan) {
  return mutateStore(store => {
    const current = store.watches.find(
      candidate => candidate.id === watch.id && candidate.viewerId === watch.viewerId
    );
    const entry = current?.discoveries.find(candidate => candidate.id === discovery.id);
    if (!current || !entry) return { store, value: false };
    return {
      store: {
        ...store,
        watches: store.watches.map(candidate =>
          candidate.id === current.id
            ? {
                ...current,
                discoveries: current.discoveries.map(candidate =>
                  candidate.id === entry.id ? { ...candidate, manualExport: plan } : candidate
                ),
              }
            : candidate
        ),
      },
      value: true,
    };
  });
}

export function saveChild(
  watch: Watch,
  entryId: string,
  planId: string,
  index: number,
  child: ExportChild,
  expected: ExportChild['state']
) {
  return mutateStore(store => {
    let saved = false;
    const watches = store.watches.map(current => {
      if (current.id !== watch.id || current.viewerId !== watch.viewerId) return current;
      const discoveries = current.discoveries.map(entry => {
        const plan = entry.manualExport;
        if (entry.id !== entryId || plan?.id !== planId || plan.children[index]?.state !== expected)
          return entry;
        saved = true;
        return {
          ...entry,
          manualExport: {
            ...plan,
            children: plan.children.map((existing, position) =>
              position === index ? child : existing
            ),
          },
        };
      });
      return { ...current, discoveries };
    });
    return { store: saved ? { ...store, watches } : store, value: saved };
  });
}

export function planOutcome(
  entryId: string,
  plan: ManualExportPlan,
  sidecar: boolean,
  batchFailure?: FailureCode
): InboxExportOutcome {
  const address = (child: number) => (sidecar ? { child } : {});
  const failures = plan.children.flatMap((child, index) =>
    child.state === 'failed'
      ? [
          {
            ...address(index),
            code:
              child.code && child.code !== 'SILENT_REENCODE_DECLINED'
                ? child.code
                : ('DOWNLOAD_UNEXPECTED_FAILURE' as const),
          },
        ]
      : []
  );
  const skipped = plan.children.flatMap((child, index) =>
    child.state === 'skipped'
      ? [{ ...address(index), code: 'SILENT_REENCODE_DECLINED' as const }]
      : []
  );
  return InboxExportOutcome.make({
    entryId,
    planId: plan.id,
    accepted: plan.children.filter(child => child.state === 'accepted').length,
    failures: batchFailure ? [{ code: batchFailure }] : failures,
    ...(skipped.length ? { skipped } : {}),
    ...(plan.children.some(child => child.state === 'accepted' && child.historySaved === false)
      ? { warning: 'HISTORY_SAVE_FAILED' as const }
      : {}),
  });
}

export const claimChild = Effect.fn(function* (
  watch: Watch,
  entryId: string,
  plan: ManualExportPlan,
  index: number
) {
  const child = plan.children[index]!;
  const write = yield* Effect.promise(() =>
    saveChild(watch, entryId, plan.id, index, { ...child, state: 'starting' }, 'pending')
  );
  return write.kind === 'ok'
    ? write.value
      ? undefined
      : ('WATCH_NOT_FOUND' as const)
    : write.code;
});
