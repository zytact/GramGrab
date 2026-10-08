import { useEffect, useState } from 'react';
import {
  AccountIdSelector,
  WatchCheck,
  WatchInboxList,
  WatchInboxRemove,
  WatchShow,
  type ActionOutcome,
  type DeferredReason,
  type DiscoverySummary,
  type InboxExportOutcome,
  type KindCheckOutcome,
  type KindHealth,
  type ManualCheck,
  type WatchCommand,
  type WatchSummary,
  type WatchViewer,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type { WatchCommandResponse, WatchFailure, WatchRead } from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { KIND_LABEL, relativeTime } from './copy.ts';
import { useInboxSelection } from './inbox-export.tsx';
import { Avatar } from './avatar.tsx';

const DAY_MS = 24 * 60 * 60_000;

export const runCommand = (command: WatchCommand): Promise<WatchCommandResponse> =>
  sendMessage({ type: 'WATCH_COMMAND', command });

export const runRead = (command: WatchRead, viewer: WatchViewer): Promise<WatchCommandResponse> =>
  sendMessage({ type: 'WATCH_READ', command, viewer });

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
      {(entry.downloadChildren?.length ?? 0) > 1 &&
        entry.downloadChildren?.map((outcome, child) => (
          <span key={`download-${child}`} className={`opt-chip opt-${outcome.state}`}>
            Download item {child + 1}: {STATE_LABEL[outcome.state]}
            {outcome.code && ` (${FAILURE_PRESENTATION[outcome.code].title})`}
          </span>
        ))}
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

/** What the last Download Original did for one entry. */
function ExportResult({
  entry,
  outcome,
}: {
  entry: DiscoverySummary;
  outcome: InboxExportOutcome;
}) {
  const accepted = outcome.accepted === 1 ? '1 file' : `${outcome.accepted} files`;
  return (
    <span className="opt-meta">
      {outcome.accepted > 0 && `Browser accepted ${accepted} for this plan. `}
      {outcome.failures.map(({ child, code }) => (
        <span key={`${child}-${code}`} className="opt-error">
          {child !== undefined && `Item ${child + 1}: `}
          {FAILURE_PRESENTATION[code].title}.{' '}
          {code === 'WATCH_MEDIA_UNAVAILABLE' && (
            <a
              href={`https://www.instagram.com/${entry.username}/`}
              target="_blank"
              rel="noreferrer"
            >
              Open in Instagram
            </a>
          )}{' '}
        </span>
      ))}
      {outcome.skipped?.map(({ child }) => (
        <span key={child ?? 'item'} className="opt-error">
          {child !== undefined && `Item ${child + 1}: `}Re-encoding needs your approval.{' '}
        </span>
      ))}
      {outcome.warning && 'It could not be added to History.'}
    </span>
  );
}

interface Selection {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (entryId: string) => void;
  readonly outcomes: ReadonlyMap<string, InboxExportOutcome>;
  readonly busy: boolean;
}

function DiscoveryCheckbox({
  entry,
  selection,
}: {
  entry: DiscoverySummary;
  selection: Selection;
}) {
  const selected = selection.selected.has(entry.entryId);
  return (
    <input
      type="checkbox"
      aria-label="Select for download"
      checked={selected}
      disabled={selection.busy || (!selected && entry.unavailable !== undefined)}
      onChange={() => selection.onToggle(entry.entryId)}
    />
  );
}

function DiscoveryList({
  entries,
  showAccount,
  onRemove,
  selection,
}: {
  entries: readonly DiscoverySummary[];
  showAccount: boolean;
  onRemove?: (entryId: string) => void;
  selection?: Selection;
}) {
  if (entries.length === 0) return <p className="opt-meta">Nothing here yet.</p>;
  return (
    <>
      {entries.map(entry => {
        const outcome = selection?.outcomes.get(entry.entryId) ?? entry.manualExport;
        return (
          <div key={entry.entryId} className="opt-line opt-row opt-top">
            {selection && <DiscoveryCheckbox entry={entry} selection={selection} />}
            <div className="opt-grow">
              <div>
                {showAccount && `@${entry.username} · `}
                {MEDIA_LABEL[entry.mediaType]}
                {entry.childCount ? ` of ${entry.childCount}` : ''}
              </div>
              <EntryMeta entry={entry} />
              <OutcomeChips entry={entry} />
              {outcome && <ExportResult entry={entry} outcome={outcome} />}
            </div>
            {onRemove && entry.inboxUntil !== undefined && (
              <button className="opt-btn opt-ghost" onClick={() => onRemove(entry.entryId)}>
                Remove
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

const removeEntry = (entryId: string) => runCommand(WatchInboxRemove.make({ entryIds: [entryId] }));

/**
 * Inbox entries a person can select and download. Exporting keeps every entry in the
 * inbox; an entry already known to be gone cannot be selected.
 */
function InboxList({
  entries,
  showAccount,
  onChanged,
}: {
  entries: readonly DiscoverySummary[];
  showAccount: boolean;
  onChanged: () => void;
}) {
  const exporter = useInboxSelection();
  return (
    <>
      <DiscoveryList
        entries={entries}
        showAccount={showAccount}
        onRemove={entryId => void removeEntry(entryId).then(onChanged)}
        selection={{
          selected: new Set(exporter.selected.keys()),
          outcomes: exporter.outcomes,
          busy: exporter.busy,
          onToggle: entryId => {
            const entry = entries.find(candidate => candidate.entryId === entryId);
            if (entry) exporter.toggle(entry);
          },
        }}
      />
    </>
  );
}

/** Every collected entry of the verified login, reloaded whenever `version` changes. */
export function AllInbox({
  viewer,
  version,
  onChanged,
}: {
  viewer: WatchViewer;
  version: number;
  onChanged: () => void;
}) {
  const [entries, setEntries] = useState<readonly DiscoverySummary[]>();
  useEffect(() => {
    let current = true;
    void runRead(WatchInboxList.make({}), viewer).then(response => {
      if (current && response.result?._tag === 'WatchInboxListResult')
        setEntries(response.result.entries);
    });
    return () => {
      current = false;
    };
  }, [viewer, version]);
  return (
    <>
      <h1 className="opt-h1">All inbox</h1>
      <p className="opt-note">
        Everything your Watches collected. Entries stay 30 days from when they were found, but
        Instagram can remove media sooner.
      </p>
      {entries ? (
        <InboxList entries={entries} showAccount onChanged={onChanged} />
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

const DEFERRED_TEXT: Record<DeferredReason, (at: string) => string> = {
  'checked-recently': at => `Checked in the last 5 minutes. Check again at ${at}.`,
  paced: at => `Watch requests are spaced out. This check can run at ${at}.`,
  'rate-limited': at => `Instagram rate limited a Watch request. Checks wait until ${at}.`,
  queued: () => 'A check of this Watch is already queued.',
};

const deferredText = (reason: DeferredReason, until: number) =>
  DEFERRED_TEXT[reason](new Date(until).toLocaleTimeString());

const CHECK_NOW_LABEL = { idle: 'Check now', checking: 'Checking…', waiting: 'Waiting…' } as const;

/** A queued check is waiting while pacing holds it back, so it never reads as running. */
function checkNowState(sending: boolean, check: ManualCheck | undefined) {
  if (sending) return 'checking';
  if (check?._tag !== 'ManualCheckPending') return 'idle';
  return (check.deferredUntil ?? 0) > Date.now() ? 'waiting' : 'checking';
}

/** Where the Watch's manual check stands, as the worker records it. */
function ManualCheckStatus({ check }: { check: ManualCheck }) {
  const done = check.outcomes.map(outcomeText).join(' · ');
  if (check._tag === 'ManualCheckFinished')
    return (
      <p className="opt-meta">
        Last check {relativeTime(check.finishedAt)}: {done || 'nothing to check'}.
      </p>
    );
  const remaining = check.remainingKinds.map(kind => KIND_LABEL[kind]).join(', ');
  const waiting =
    check.deferredUntil !== undefined && check.deferredReason && check.deferredUntil > Date.now()
      ? deferredText(check.deferredReason, check.deferredUntil)
      : undefined;
  return (
    <p className="opt-meta">
      {done && `${done}. `}
      {remaining && `Still to check: ${remaining}. `}
      {waiting}
    </p>
  );
}

/**
 * Puts the Watch at the front of the queue; pacing may still hold it back. Whether it is checking
 * comes from the worker's record, so it survives leaving the Watch or reloading the page.
 */
function CheckNow({ watch, onChecked }: { watch: WatchSummary; onChecked: () => void }) {
  const { manualCheck } = watch;
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<WatchFailure>();
  const state = checkNowState(sending, manualCheck);
  const check = async () => {
    setSending(true);
    setNotice(undefined);
    const response = await runCommand(
      WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: watch.accountId })] })
    );
    setSending(false);
    setFailure(response.failure);
    const outcome =
      response.result?._tag === 'WatchCheckResult' ? response.result.outcomes[0] : undefined;
    if (outcome?.deferredUntil !== undefined)
      setNotice(deferredText(outcome.deferredReason ?? 'paced', outcome.deferredUntil));
    else if (
      outcome?.kinds.some(kind => kind._tag === 'KindCheckSkipped' && kind.reason === 'storage')
    )
      setNotice(outcome.kinds.map(outcomeText).join(' · '));
    onChecked();
  };
  return (
    <div className="opt-col">
      <button
        className="opt-btn"
        disabled={state !== 'idle' || !watch.enabled}
        onClick={() => void check()}
      >
        {CHECK_NOW_LABEL[state]}
      </button>
      {manualCheck && <ManualCheckStatus check={manualCheck} />}
      {notice && <p className="opt-meta">{notice}</p>}
      {failure?._tag === 'CommandFailure' && (
        <p className="opt-meta opt-error">{FAILURE_PRESENTATION[failure.failure.code].title}</p>
      )}
    </div>
  );
}

/** One Watch's health and what it found, reloaded whenever `version` changes. */
export function WatchDetail({
  viewer,
  watch,
  avatar,
  version,
  onChanged,
}: {
  viewer: WatchViewer;
  watch: WatchSummary;
  avatar: string | undefined;
  version: number;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'found' | 'inbox'>('found');
  const [found, setFound] = useState<readonly DiscoverySummary[]>();
  const { accountId } = watch;
  useEffect(() => {
    let current = true;
    void runRead(WatchShow.make({ watch: AccountIdSelector.make({ accountId }) }), viewer).then(
      response => {
        if (current && response.result?._tag === 'WatchShowResult')
          setFound(response.result.discoveries);
      }
    );
    return () => {
      current = false;
    };
  }, [viewer, accountId, version]);
  const inbox = found?.filter(entry => entry.inboxUntil !== undefined);
  return (
    <>
      <div className="opt-row opt-between">
        <Avatar src={avatar} username={watch.username} size="lg" />
        <div className="opt-account-text opt-grow">
          <a
            className="opt-h1 opt-profile-link"
            href={`https://www.instagram.com/${watch.username}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            @{watch.username}
          </a>
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
        tab === 'found' ? (
          <DiscoveryList entries={found} showAccount={false} />
        ) : (
          <InboxList entries={inbox} showAccount={false} onChanged={onChanged} />
        )
      ) : (
        <p className="opt-meta">Loading…</p>
      )}
    </>
  );
}
