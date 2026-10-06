import {
  RecoveryOutcome,
  WatchRecover,
  type WatchCommand,
  type DiscoverySummary,
  type ActionOutcome,
} from '@gramgrab/protocol';
import type { ChildDownload, Discovery } from './contracts.ts';
import { retryableDownload } from './auto-download.ts';

type Recovery = Extract<WatchCommand, { _tag: 'WatchRecover' }>;

function recoverChild(child: ChildDownload, operation: Recovery['operation']): ChildDownload {
  if (operation === 'retry') return retryableDownload(child) ? { status: 'pending' } : child;
  if (operation === 'dismiss')
    return child.status === 'failed' ? { ...child, dismissed: true } : child;
  if (child.status !== 'uncertain') return child;
  return operation === 'confirm' ? { status: 'confirmed', at: Date.now() } : { status: 'pending' };
}

export function recoverable(entry: Discovery, command: Recovery): boolean {
  const { action, operation } = command;
  if (action !== 'download' && command.child !== undefined) return false;
  if (action === 'notify')
    return (
      entry.notify?.status === 'failed' &&
      !entry.notify.dismissed &&
      (operation === 'retry' || operation === 'dismiss')
    );
  if (action === 'collect')
    return (
      entry.collect !== undefined &&
      'status' in entry.collect &&
      entry.collect.status === 'failed' &&
      !entry.collect.dismissed &&
      (operation === 'retry' || operation === 'dismiss')
    );
  const download = entry.download;
  if (!download || download.dismissed) return false;
  const children = download.children.filter(
    (child, index) =>
      (command.child === undefined || command.child === index) &&
      !(child.status === 'failed' && child.dismissed)
  );
  if (operation === 'retry') return children.some(retryableDownload);
  return children.some(
    child => child.status === (operation === 'dismiss' ? 'failed' : 'uncertain')
  );
}

export function applyRecovery(entry: Discovery, command: Recovery): Discovery {
  if (!recoverable(entry, command)) return entry;
  const { action, operation } = command;
  if (action === 'notify' && entry.notify?.status === 'failed')
    return {
      ...entry,
      notify:
        operation === 'dismiss' ? { ...entry.notify, dismissed: true } : { status: 'pending' },
    };
  if (
    action === 'collect' &&
    entry.collect &&
    'status' in entry.collect &&
    entry.collect.status === 'failed'
  )
    return {
      ...entry,
      collect:
        operation === 'dismiss' ? { ...entry.collect, dismissed: true } : { status: 'pending' },
    };
  if (!entry.download) return entry;
  const children = entry.download.children.map((child, index) => {
    if (command.child !== undefined && command.child !== index) return child;
    if (child.status === 'failed' && child.dismissed) return child;
    return recoverChild(child, operation);
  });
  return {
    ...entry,
    download: { ...entry.download, children, dismissed: false },
  };
}

function affectedOutcomes(
  before: Discovery,
  after: DiscoverySummary,
  command: Recovery
): readonly ActionOutcome[] {
  if (command.action !== 'download') {
    const action = after[command.action];
    return action ? [action] : [];
  }
  return (
    before.download?.children.flatMap((_, index) => {
      if (command.child !== undefined && command.child !== index) return [];
      const selected = recoverable(
        before,
        WatchRecover.make({
          action: 'download',
          operation: command.operation,
          entryIds: command.entryIds,
          child: index,
        })
      );
      const outcome = after.downloadChildren?.[index];
      return selected && outcome ? [outcome] : [];
    }) ?? []
  );
}

function recovered(outcomes: readonly ActionOutcome[], operation: Recovery['operation']): boolean {
  return (
    outcomes.length > 0 &&
    outcomes.every(
      outcome => outcome.state === 'done' || (operation === 'dismiss' && outcome.dismissed)
    )
  );
}

export function recoveryOutcome(
  before: Discovery,
  after: DiscoverySummary | undefined,
  command: Recovery
): RecoveryOutcome {
  if (!after)
    return RecoveryOutcome.make({ entryId: before.id, state: 'failed', code: 'WATCH_NOT_FOUND' });
  const outcomes = affectedOutcomes(before, after, command);
  if (recovered(outcomes, command.operation))
    return RecoveryOutcome.make({ entryId: before.id, state: 'recovered' });
  const failed = outcomes.find(outcome => outcome.state === 'failed' && !outcome.dismissed);
  const state = failed
    ? 'failed'
    : outcomes.some(outcome => outcome.state === 'unconfirmed')
      ? 'unconfirmed'
      : 'waiting';
  return RecoveryOutcome.make({
    entryId: before.id,
    state,
    ...(failed?.code ? { code: failed.code } : {}),
  });
}
