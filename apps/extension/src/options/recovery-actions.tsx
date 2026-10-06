import {
  WatchRecover,
  type ActionOutcome,
  type DiscoverySummary,
  type WatchCommand,
} from '@gramgrab/protocol';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { KIND_LABEL, relativeTime } from './copy.ts';

type Recovery = Extract<WatchCommand, { _tag: 'WatchRecover' }>;

const finalCodes = new Set([
  'WATCH_STORY_EXPIRED',
  'WATCH_AVATAR_CHANGED',
  'WATCH_INSTANT_NOT_IN_FEED',
  'WATCH_MEDIA_UNAVAILABLE',
]);

function RecoveryRow({
  entry,
  action,
  outcome,
  child,
  onRun,
}: {
  entry: DiscoverySummary;
  action: Recovery['action'];
  outcome: ActionOutcome;
  child?: number;
  onRun: (command: WatchCommand) => unknown;
}) {
  const recover = (operation: Recovery['operation']) => {
    onRun(
      WatchRecover.make({
        action,
        operation,
        entryIds: [entry.entryId],
        ...(child === undefined ? {} : { child }),
      })
    );
  };
  const copy = outcome.code ? FAILURE_PRESENTATION[outcome.code] : undefined;
  return (
    <div className="opt-line opt-row opt-top">
      <div className="opt-grow">
        <strong>
          @{entry.username} · {KIND_LABEL[entry.kind]} · {action}
          {child === undefined ? '' : ` item ${child + 1}`}
        </strong>
        <span className="opt-meta">
          Found {relativeTime(entry.discoveredAt)}. {copy?.title}
        </span>
        {outcome.state === 'unconfirmed' && (
          <span className="opt-meta">
            The browser may have accepted this file before GramGrab stopped. Check your downloads
            before downloading again.
          </span>
        )}
      </div>
      {outcome.state === 'unconfirmed' ? (
        <>
          <button className="opt-btn" onClick={() => recover('confirm')}>
            I have the file
          </button>
          <button className="opt-btn opt-ghost" onClick={() => recover('download-again')}>
            Download again
          </button>
        </>
      ) : (
        <>
          {(!outcome.code || !finalCodes.has(outcome.code)) && (
            <button className="opt-btn" onClick={() => recover('retry')}>
              Retry
            </button>
          )}
          <button className="opt-btn opt-ghost" onClick={() => recover('dismiss')}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

export function RecoveryActions({
  entry,
  onRun,
}: {
  entry: DiscoverySummary;
  onRun: (command: WatchCommand) => unknown;
}) {
  const needs = (outcome: ActionOutcome | undefined) =>
    outcome &&
    !outcome.dismissed &&
    (outcome.state === 'failed' || outcome.state === 'unconfirmed');
  return (
    <>
      {needs(entry.notify) && entry.notify && (
        <RecoveryRow entry={entry} action="notify" outcome={entry.notify} onRun={onRun} />
      )}
      {needs(entry.collect) && entry.collect && (
        <RecoveryRow entry={entry} action="collect" outcome={entry.collect} onRun={onRun} />
      )}
      {entry.downloadChildren?.map((outcome, child) =>
        needs(outcome) ? (
          <RecoveryRow
            key={child}
            entry={entry}
            action="download"
            outcome={outcome}
            child={child}
            onRun={onRun}
          />
        ) : null
      )}
    </>
  );
}
