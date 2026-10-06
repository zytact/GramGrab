import { useEffect, useState } from 'react';
import {
  AccountIdSelector,
  WatchCheck,
  WatchInboxList,
  WatchInboxRemove,
  WatchShow,
  type ActionOutcome,
  type DiscoverySummary,
  type KindCheckOutcome,
  type KindHealth,
  type WatchCommand,
  type WatchSummary,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type { WatchCommandResponse, WatchFailure } from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { KIND_LABEL, relativeTime } from './copy.ts';

const DAY_MS = 24 * 60 * 60_000;

export const runCommand = (command: WatchCommand): Promise<WatchCommandResponse> =>
  sendMessage({ type: 'WATCH_COMMAND', command });

export function healthText(health: KindHealth, enabled: boolean): string {
  switch (health._tag) {
    case 'KindOff':
      return health.baselineKept
        ? 'Off. Its baseline is kept, so turning it back on catches up on the last 30 days.'
        : 'Off.';
    case 'KindBaselinePending':
      return enabled
        ? 'First check pending. It records what is already there and acts on nothing.'
        : 'Paused before its first check.';
    case 'KindChecked':
      if (!enabled) return 'Paused';
      return health.catchingUp
        ? `Catching up. Older pages continue later this round. Last full check ${relativeTime(health.lastSuccessAt)}.`
        : `Checked ${relativeTime(health.lastSuccessAt)}`;
    case 'KindProblem': {
      const copy = FAILURE_PRESENTATION[health.code];
      const last = health.lastSuccessAt
        ? ` Last success ${relativeTime(health.lastSuccessAt)}.`
        : '';
      return `${copy.title}. ${copy.explanation}${last}`;
    }
  }
}

const HEALTH_CLASS: Record<KindHealth['_tag'], string> = {
  KindOff: 'opt-health-off',
  KindBaselinePending: 'opt-health-baseline',
  KindChecked: '',
  KindProblem: 'opt-health-problem',
};

function KindHealthList({ watch }: { watch: WatchSummary }) {
  return (
    <div className="opt-health">
      {watch.kinds.map(health => (
        <div key={health.kind} className={`opt-health-row ${HEALTH_CLASS[health._tag]}`}>
          <strong>{KIND_LABEL[health.kind]}</strong>
          <span>{healthText(health, watch.enabled)}</span>
        </div>
      ))}
    </div>
  );
}

const MEDIA_LABEL: Record<DiscoverySummary['mediaType'], string> = {
  image: 'Photo',
  video: 'Video',
  sidecar: 'Carousel',
  avatar: 'New picture',
};

const OUTCOME_LABEL = { notify: 'Notified', download: 'Downloaded', collect: 'Collected' } as const;
const STATE_LABEL: Record<ActionOutcome['state'], string> = {
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  unconfirmed: 'unconfirmed',
};

function OutcomeChips({ entry }: { entry: DiscoverySummary }) {
  return (
    <span className="opt-chips">
      {(['notify', 'download', 'collect'] as const).flatMap(action => {
        const outcome = entry[action];
        return outcome
          ? [
              <span key={action} className={`opt-chip opt-${outcome.state}`}>
                {OUTCOME_LABEL[action]}: {STATE_LABEL[outcome.state]}
              </span>,
            ]
          : [];
      })}
    </span>
  );
}

function EntryMeta({ entry }: { entry: DiscoverySummary }) {
  const days = entry.inboxUntil ? Math.ceil((entry.inboxUntil - Date.now()) / DAY_MS) : undefined;
  return (
    <span className="opt-meta">
      {KIND_LABEL[entry.kind]} · found {relativeTime(entry.discoveredAt)}
      {days !== undefined && ` · leaves the inbox in ${days} ${days === 1 ? 'day' : 'days'}`}
      {entry.unavailable && (
        <span className="opt-error"> · {FAILURE_PRESENTATION[entry.unavailable].title}</span>
      )}
      {entry.missingChildren ? (
        <span className="opt-error">
          {' '}
          · {entry.missingChildren} of {entry.childCount} no longer available
        </span>
      ) : null}
    </span>
  );
}

function DiscoveryList({
  entries,
  showAccount,
  onRemove,
}: {
  entries: readonly DiscoverySummary[];
  showAccount: boolean;
  onRemove?: (entryId: string) => void;
}) {
  if (entries.length === 0) return <p className="opt-meta">Nothing here yet.</p>;
  return (
    <>
      {entries.map(entry => (
        <div key={entry.entryId} className="opt-line opt-row opt-top">
          <div className="opt-grow">
            <div>
              {showAccount && `@${entry.username} · `}
              {MEDIA_LABEL[entry.mediaType]}
              {entry.childCount ? ` of ${entry.childCount}` : ''}
            </div>
            <EntryMeta entry={entry} />
            <OutcomeChips entry={entry} />
          </div>
          {onRemove && entry.inboxUntil !== undefined && (
            <button className="opt-btn opt-ghost" onClick={() => onRemove(entry.entryId)}>
              Remove
            </button>
          )}
        </div>
      ))}
    </>
  );
}

const removeEntry = (entryId: string) => runCommand(WatchInboxRemove.make({ entryIds: [entryId] }));

/** Every collected entry of the verified login, reloaded whenever `version` changes. */
export function AllInbox({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [entries, setEntries] = useState<readonly DiscoverySummary[]>();
  useEffect(() => {
    let current = true;
    void runCommand(WatchInboxList.make({})).then(response => {
      if (current && response.result?._tag === 'WatchInboxListResult')
        setEntries(response.result.entries);
    });
    return () => {
      current = false;
    };
  }, [version]);
  return (
    <>
      <h1 className="opt-h1">All inbox</h1>
      <p className="opt-note">
        Everything your Watches collected. Entries stay 30 days from when they were found, but
        Instagram can remove media sooner.
      </p>
      {entries ? (
        <DiscoveryList
          entries={entries}
          showAccount
          onRemove={entryId => void removeEntry(entryId).then(onChanged)}
        />
      ) : (
        <p className="opt-meta">Loading…</p>
      )}
    </>
  );
}

function outcomeText(outcome: KindCheckOutcome): string {
  const kind = KIND_LABEL[outcome.kind];
  switch (outcome._tag) {
    case 'KindBaselineRecorded':
      return `${kind}: baseline recorded`;
    case 'KindCheckSucceeded':
      return `${kind}: ${outcome.newCount} new`;
    case 'KindCheckFailed':
      return `${kind}: ${FAILURE_PRESENTATION[outcome.code].title}`;
    case 'KindCheckSkipped':
      return `${kind}: skipped (${outcome.reason})`;
  }
}

/** Puts the Watch at the front of the queue; pacing may still hold it back. */
function CheckNow({ watch, onChecked }: { watch: WatchSummary; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failure, setFailure] = useState<WatchFailure>();
  const check = async () => {
    setBusy(true);
    setMessage(undefined);
    const response = await runCommand(
      WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: watch.accountId })] })
    );
    setBusy(false);
    setFailure(response.failure);
    const outcome =
      response.result?._tag === 'WatchCheckResult' ? response.result.outcomes[0] : undefined;
    if (outcome?.deferredUntil)
      setMessage(
        `Watch checks are paced. This one can run at ${new Date(outcome.deferredUntil).toLocaleTimeString()}.`
      );
    else if (outcome) setMessage(outcome.kinds.map(outcomeText).join(' · ') || 'Nothing to check.');
    onChecked();
  };
  return (
    <div className="opt-col">
      <button className="opt-btn" disabled={busy || !watch.enabled} onClick={() => void check()}>
        {busy ? 'Checking…' : 'Check now'}
      </button>
      {message && <p className="opt-meta">{message}</p>}
      {failure?._tag === 'CommandFailure' && (
        <p className="opt-meta opt-error">{FAILURE_PRESENTATION[failure.failure.code].title}</p>
      )}
    </div>
  );
}

/** One Watch's health and what it found, reloaded whenever `version` changes. */
export function WatchDetail({
  watch,
  version,
  onChanged,
}: {
  watch: WatchSummary;
  version: number;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'found' | 'inbox'>('found');
  const [found, setFound] = useState<readonly DiscoverySummary[]>();
  const { accountId } = watch;
  useEffect(() => {
    let current = true;
    void runCommand(WatchShow.make({ watch: AccountIdSelector.make({ accountId }) })).then(
      response => {
        if (current && response.result?._tag === 'WatchShowResult')
          setFound(response.result.discoveries);
      }
    );
    return () => {
      current = false;
    };
  }, [accountId, version]);
  const inbox = found?.filter(entry => entry.inboxUntil !== undefined);
  return (
    <>
      <div className="opt-row opt-between">
        <div className="opt-account-text">
          <span className="opt-h1">@{watch.username}</span>
          {watch.formerUsername && <span className="opt-meta">was @{watch.formerUsername}</span>}
        </div>
        <CheckNow watch={watch} onChecked={onChanged} />
      </div>
      {!watch.enabled && (
        <p className="opt-banner">
          Paused. The inbox and baselines are kept. Resuming catches up on the last 30 days.
        </p>
      )}
      <KindHealthList watch={watch} />
      <div className="opt-tabs">
        <button className={tab === 'found' ? 'active' : ''} onClick={() => setTab('found')}>
          Found ({found?.length ?? 0})
        </button>
        <button className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}>
          Inbox ({inbox?.length ?? 0})
        </button>
      </div>
      {found && inbox ? (
        <DiscoveryList
          entries={tab === 'found' ? found : inbox}
          showAccount={false}
          onRemove={
            tab === 'inbox' ? entryId => void removeEntry(entryId).then(onChanged) : undefined
          }
        />
      ) : (
        <p className="opt-meta">Loading…</p>
      )}
    </>
  );
}
