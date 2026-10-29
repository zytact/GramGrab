import { useEffect, useState, type ReactNode } from 'react';
import {
  AccountIdSelector,
  InstagramLogin,
  WatchCheck,
  WatchInboxList,
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
import type {
  WatchAvatarsResponse,
  WatchCommandResponse,
  WatchFailure,
  WatchRead,
} from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { StoryExpiry } from '../popup/story-expiry.tsx';
import { KIND_LABEL, relativeTime, WATCH_AVATAR_NOTE } from './copy.ts';
import { useInboxSelection } from './inbox-export.tsx';
import { Avatar } from './avatar.tsx';
import { DiagnosticsPreview } from './diagnostics-preview.tsx';
import { OWNER_LABEL, OwnerTag, type LoginList } from './owners.tsx';

const DAY_MS = 24 * 60 * 60_000;

export const runCommand = (
  command: WatchCommand,
  login: InstagramLogin
): Promise<WatchCommandResponse> => sendMessage({ type: 'WATCH_COMMAND', command, login });

export const runRead = (
  command: WatchRead,
  viewer: WatchViewer,
  login: InstagramLogin
): Promise<WatchCommandResponse> => sendMessage({ type: 'WATCH_READ', command, viewer, login });

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
          {health._tag === 'KindProblem' &&
            FAILURE_PRESENTATION[health.code].actions.includes('copy-diagnostics') && (
              <DiagnosticsPreview
                key={`${health.code}:${health.reason}`}
                failure={{
                  code: health.code,
                  phase: 'resolving',
                  scope: 'batch',
                  mediaKind: health.kind,
                  ...(health.reason ? { reason: health.reason } : {}),
                }}
              />
            )}
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
      aria-label="Select inbox item"
      checked={selected}
      disabled={selection.busy}
      onChange={() => selection.onToggle(entry.entryId)}
    />
  );
}

type Avatars = WatchAvatarsResponse['watches'];

/** The entry's media link, after its account and Avatar when `avatars` is given. */
function EntryHeading({ entry, avatars }: { entry: DiscoverySummary; avatars?: Avatars }) {
  const link = (
    <a className="opt-entry-link" href={entry.instagramUrl} target="_blank" rel="noreferrer">
      {MEDIA_LABEL[entry.mediaType]}
      {entry.childCount ? ` of ${entry.childCount}` : ''}
    </a>
  );
  if (!avatars) return <div>{link}</div>;
  return (
    <div className="opt-row opt-entry-head">
      <Avatar
        src={avatars[entry.watchId]}
        username={entry.username}
        size="sm"
        placeholderHint={WATCH_AVATAR_NOTE}
      />
      <span>
        <OwnerTag watchId={entry.watchId} />@{entry.username} · {link}
      </span>
    </div>
  );
}

/** Discovery rows. Given `avatars`, each row names its account with its Avatar. */
function DiscoveryList({
  entries,
  avatars,
  onRemove,
  selection,
}: {
  entries: readonly DiscoverySummary[];
  avatars?: Avatars;
  onRemove?: (entry: DiscoverySummary) => void;
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
              <EntryHeading entry={entry} avatars={avatars} />
              <EntryMeta entry={entry} />
              <StoryExpiry expiresAt={entry.expiresAt} />
              <OutcomeChips entry={entry} />
              {outcome && <ExportResult entry={entry} outcome={outcome} />}
            </div>
            {onRemove && entry.inboxUntil !== undefined && (
              <button
                className="opt-btn opt-ghost"
                disabled={selection?.busy}
                onClick={() => onRemove(entry)}
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Inbox entries a person can select, download or remove. Exporting keeps entries in the inbox.
 */
function InboxList({
  entries,
  avatars,
}: {
  entries: readonly DiscoverySummary[];
  avatars?: Avatars;
}) {
  const exporter = useInboxSelection();
  const selectedEntries = entries.filter(entry => exporter.selected.has(entry.entryId));
  return (
    <>
      {entries.length > 0 && (
        <div className="opt-row opt-line" role="group" aria-label="Inbox selection">
          <button
            className="opt-btn"
            disabled={exporter.busy || selectedEntries.length === entries.length}
            onClick={() => exporter.selectAll(entries)}
          >
            Select all
          </button>
          <button
            className="opt-btn opt-ghost"
            disabled={exporter.busy || selectedEntries.length === 0}
            onClick={exporter.clear}
          >
            Clear selection
          </button>
          <button
            className="opt-btn opt-danger"
            disabled={exporter.busy || selectedEntries.length === 0}
            onClick={() => exporter.remove(selectedEntries)}
          >
            Remove selected ({selectedEntries.length})
          </button>
        </div>
      )}
      <DiscoveryList
        entries={entries}
        avatars={avatars}
        onRemove={entry => exporter.remove([entry])}
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

/** One chip of an All inbox filter row. */
interface FilterOption {
  readonly key: string;
  readonly label: ReactNode;
  readonly matches: (entry: DiscoverySummary) => boolean;
}

const everything = () => true;
const isStory = (entry: DiscoverySummary) => entry.kind === 'stories';

/** Media types without overlap: Stories are their own type, and a new picture counts as a photo. */
const MEDIA_FILTERS: readonly FilterOption[] = [
  { key: 'all', label: 'Everything', matches: everything },
  {
    key: 'photos',
    label: 'Photos',
    matches: entry =>
      !isStory(entry) && (entry.mediaType === 'image' || entry.mediaType === 'avatar'),
  },
  {
    key: 'videos',
    label: 'Videos',
    matches: entry => !isStory(entry) && entry.mediaType === 'video',
  },
  { key: 'carousels', label: 'Carousels', matches: entry => entry.mediaType === 'sidecar' },
  { key: 'stories', label: 'Stories', matches: isStory },
];

/**
 * All accounts, then each login while more than one owns an entry, then each Watch with an entry
 * by username.
 */
function accountFilters(
  entries: readonly DiscoverySummary[],
  lists: readonly LoginList[]
): FilterOption[] {
  const loginOf = new Map(
    lists.flatMap(({ login, list }) => list.watches.map(watch => [watch.watchId, login] as const))
  );
  const logins = InstagramLogin.literals.filter(login =>
    entries.some(entry => loginOf.get(entry.watchId) === login)
  );
  const watches = [...new Map(entries.map(entry => [entry.watchId, entry.username]))].toSorted(
    ([, left], [, right]) => left.localeCompare(right)
  );
  return [
    { key: 'all', label: 'All accounts', matches: everything },
    ...(logins.length > 1
      ? logins.map(login => ({
          key: `login:${login}`,
          label: OWNER_LABEL[login],
          matches: (entry: DiscoverySummary) => loginOf.get(entry.watchId) === login,
        }))
      : []),
    ...watches.map(([watchId, username]) => ({
      key: watchId,
      label: (
        <>
          <OwnerTag watchId={watchId} />@{username}
        </>
      ),
      matches: (entry: DiscoverySummary) => entry.watchId === watchId,
    })),
  ];
}

/** A row of chips that picks one option. A picked key no longer offered falls back to the first. */
function useFilter(options: readonly FilterOption[]) {
  const [key, setKey] = useState('all');
  const picked = options.find(option => option.key === key) ?? options[0]!;
  return { options, picked, setKey };
}

function FilterChips({
  label,
  filter: { options, picked, setKey },
  disabled,
  onChange,
}: {
  label: string;
  filter: ReturnType<typeof useFilter>;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <div className="opt-chip-filter" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.key}
          aria-pressed={option === picked}
          disabled={disabled}
          onClick={() => {
            if (option === picked) return;
            setKey(option.key);
            onChange();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Inbox entries narrowed by account and media type. Changing a filter clears the selection and
 * export state, as changing views does, so nothing hidden stays selected.
 */
function FilteredInbox({
  entries,
  lists,
  avatars,
}: {
  entries: readonly DiscoverySummary[];
  lists: readonly LoginList[];
  avatars: Avatars;
}) {
  const exporter = useInboxSelection();
  const account = useFilter(accountFilters(entries, lists));
  const media = useFilter(MEDIA_FILTERS);
  const shown = entries.filter(
    entry => account.picked.matches(entry) && media.picked.matches(entry)
  );
  return (
    <>
      <FilterChips
        label="Account"
        filter={account}
        disabled={exporter.busy}
        onChange={exporter.clear}
      />
      <FilterChips
        label="Media type"
        filter={media}
        disabled={exporter.busy}
        onChange={exporter.clear}
      />
      {shown.length > 0 ? (
        <InboxList entries={shown} avatars={avatars} />
      ) : (
        <p className="opt-meta">Nothing matches these filters.</p>
      )}
    </>
  );
}

/** Every collected entry of the signed-in logins, newest first, reloaded when `version` changes. */
export function AllInbox({
  lists,
  avatars,
  version,
}: {
  lists: readonly LoginList[];
  avatars: Avatars;
  version: number;
}) {
  const [entries, setEntries] = useState<readonly DiscoverySummary[]>();
  useEffect(() => {
    let current = true;
    void Promise.all(
      lists.map(({ login, list }) => runRead(WatchInboxList.make({}), list.viewer, login))
    ).then(responses => {
      if (!current) return;
      setEntries(
        responses
          .flatMap(response =>
            response.result?._tag === 'WatchInboxListResult' ? response.result.entries : []
          )
          .sort((left, right) => right.discoveredAt - left.discoveredAt)
      );
    });
    return () => {
      current = false;
    };
  }, [lists, version]);
  return (
    <>
      <h1 className="opt-h1">All inbox</h1>
      <p className="opt-note">
        Everything your Watches collected. Entries stay 30 days from when they were found, but
        Instagram can remove media sooner.
      </p>
      {!entries ? (
        <p className="opt-meta">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="opt-meta">Nothing here yet.</p>
      ) : (
        <FilteredInbox entries={entries} lists={lists} avatars={avatars} />
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
function CheckNow({
  watch,
  login,
  onChecked,
}: {
  watch: WatchSummary;
  login: InstagramLogin;
  onChecked: () => void;
}) {
  const { manualCheck } = watch;
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<WatchFailure>();
  const state = checkNowState(sending, manualCheck);
  const check = async () => {
    setSending(true);
    setNotice(undefined);
    const response = await runCommand(
      WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: watch.accountId })] }),
      login
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
    <div className="opt-check-now">
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

/** One Watch's health and what it found, read as its owner and reloaded when `version` changes. */
export function WatchDetail({
  owner: { login, list },
  watch,
  avatar,
  version,
  onChanged,
}: {
  owner: LoginList;
  watch: WatchSummary;
  avatar: string | undefined;
  version: number;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'found' | 'inbox'>('inbox');
  const [found, setFound] = useState<readonly DiscoverySummary[]>();
  const { accountId } = watch;
  const { viewer } = list;
  useEffect(() => {
    let current = true;
    void runRead(
      WatchShow.make({ watch: AccountIdSelector.make({ accountId }) }),
      viewer,
      login
    ).then(response => {
      if (current && response.result?._tag === 'WatchShowResult')
        setFound(response.result.discoveries);
    });
    return () => {
      current = false;
    };
  }, [viewer, login, accountId, version]);
  const inbox = found?.filter(entry => entry.inboxUntil !== undefined);
  return (
    <>
      <div className="opt-row opt-between">
        <Avatar
          src={avatar}
          username={watch.username}
          size="lg"
          placeholderHint={WATCH_AVATAR_NOTE}
        />
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
        <CheckNow watch={watch} login={login} onChecked={onChanged} />
      </div>
      {!watch.enabled && (
        <p className="opt-banner">
          Paused. The inbox and baselines are kept. Resuming catches up on the last 30 days.
        </p>
      )}
      <KindHealthList watch={watch} />
      <div className="opt-tabs">
        <button className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}>
          Inbox ({inbox?.length ?? 0})
        </button>
        <button className={tab === 'found' ? 'active' : ''} onClick={() => setTab('found')}>
          Found ({found?.length ?? 0})
        </button>
      </div>
      {found && inbox ? (
        tab === 'inbox' ? (
          <InboxList entries={inbox} />
        ) : (
          <DiscoveryList entries={found} />
        )
      ) : (
        <p className="opt-meta">Loading…</p>
      )}
    </>
  );
}
