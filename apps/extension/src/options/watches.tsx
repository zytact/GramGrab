import { Option } from 'effect';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccountIdSelector,
  CommandFailure,
  InstagramLogin,
  OperationFailure,
  StoredWatchCount,
  UNATTENDED_DISCLOSURE,
  WATCH_ACTIONS,
  WATCH_KINDS,
  WatchAdd,
  WatchLifecycle,
  WatchList,
  WatchSet,
  type WatchAction,
  type WatchCommand,
  type WatchKind,
  type WatchListResult,
  type WatchSchedule,
  type FailureCode,
  type HeldWatch,
  type WatchSummary,
  type WatchViewer,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type {
  LinkedLoginState,
  WatchCommandResponse,
  WatchAvatarsResponse,
  WatchFailure,
  WatchPreviewResponse,
} from '../messaging/contracts.ts';
import { linkedLoginState } from '../instagram/linked-login.ts';
import { LoginPicker, useLoginChoice, useLogins, type Logins } from '../popup/login-picker.tsx';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { watchFailure } from '../errors/contracts.ts';
import { browser, type StorageChanges } from '../lib/browser.ts';
import { decodeLedger, LEDGER_KEYS, type LedgerView } from '../instagram/request-state.ts';
import { STORE_KEY, VIEWER_KEYS, decodeCachedViewer } from '../watch/contracts.ts';
import {
  SCHEDULER_KEY,
  decodeSchedulerState,
  watchSchedule,
  type SchedulerState,
} from '../watch/schedule-state.ts';
import {
  ACTION_LABEL,
  ACTION_NOTE,
  KIND_LABEL,
  KIND_NOTE,
  relativeTime,
  WATCH_AVATAR_NOTE,
} from './copy.ts';
import { InboxExportContext, InboxExportControls, useInboxExport } from './inbox-export.tsx';
import { RecoveryActions } from './recovery-actions.tsx';
import { AllInbox, WatchDetail, healthText, runCommand, runRead } from './watch-detail.tsx';
import { Avatar } from './avatar.tsx';
import { DiagnosticsPreview } from './diagnostics-preview.tsx';
import { WatchTransfer } from './watch-transfer.tsx';
import { askToNotify } from './notify-permission.ts';
import { LoginsSection } from './logins.tsx';
import {
  OWNER_LABEL,
  OwnerTag,
  OwnerTagContext,
  pageWatches,
  type LoginList,
  type PageWatch,
} from './owners.tsx';

type View = 'attention' | 'inbox' | 'new' | 'transfer' | { readonly watchId: string };

/** A notification opens `#watch=<id>`. */
const linkedView = (): View | undefined => {
  const watchId = new URLSearchParams(location.hash.slice(1)).get('watch');
  return watchId ? { watchId } : undefined;
};

/** Both logins' verified lists. The main login's comes first and holds the held Watches. */
interface Lists {
  readonly main: WatchListResult;
  readonly linked: WatchListResult | undefined;
  /** Why the linked login's list could not be read while it is linked. */
  readonly linkedFailure: WatchFailure | undefined;
  readonly linkedState: LinkedLoginState;
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly lists: Lists }
  | { readonly kind: 'failed'; readonly failure: WatchFailure };

/** Runs a command as the login that owns what it changes. */
type Run = (command: WatchCommand, login: InstagramLogin) => Promise<WatchFailure | undefined>;

const toggled = <T,>(values: readonly T[], value: T): T[] =>
  values.includes(value) ? values.filter(item => item !== value) : [...values, value];

const ordered = <T extends string>(all: readonly T[], chosen: readonly T[]) =>
  all.filter(value => chosen.includes(value));

function FailureNotice({ failure, label }: { failure: WatchFailure; label?: string }) {
  const named = label ? `${label}: ` : '';
  if (failure._tag === 'ValidationFailure')
    return (
      <p className="opt-banner opt-banner-error">
        {named}
        {failure.message}
      </p>
    );
  const copy = FAILURE_PRESENTATION[failure.failure.code];
  return (
    <p className="opt-banner opt-banner-error">
      <strong>
        {named}
        {copy.title}.
      </strong>{' '}
      {copy.explanation}
    </p>
  );
}

const storedCount = (failure: WatchFailure) =>
  failure._tag === 'CommandFailure' && failure.detail?._tag === 'StoredWatchCount'
    ? failure.detail.count
    : 0;

/** The page shown when GramGrab cannot confirm who is signed in. Nothing owner-bound appears. */
function LoginGate({ failure }: { failure: WatchFailure }) {
  const stored = storedCount(failure);
  const signedOut =
    failure._tag === 'CommandFailure' && failure.failure.code === 'IG_NOT_AUTHENTICATED';
  const logins = useLogins();
  return (
    <div className="opt-gate">
      <Title />
      <h1 className="opt-h1">{signedOut ? 'Sign in to Instagram' : 'Watches are unavailable'}</h1>
      {signedOut ? (
        <p className="opt-note">
          GramGrab could not confirm which Instagram account this browser is signed in to, so all
          Watch checks are paused. Your Watches are kept and come back when the login that created
          them is signed in again.
        </p>
      ) : (
        <FailureNotice failure={failure} />
      )}
      <p className="opt-meta">
        {stored} {stored === 1 ? 'Watch' : 'Watches'} stored in this browser.
      </p>
      {signedOut && (
        <a className="opt-btn opt-primary" href="https://www.instagram.com/" target="_blank">
          Open instagram.com
        </a>
      )}
      <LoginsSection logins={logins} onChange={logins.reload} />
    </div>
  );
}

function Title() {
  return (
    <div className="opt-title">
      <div className="ext-logo">
        Gram<em>Grab</em>
      </div>
      <span className="opt-beta">Watches Beta</span>
    </div>
  );
}

function StorageMeter({ storage }: { storage: WatchListResult['storage'] }) {
  const unreadable = storage.status === 'unreadable' || storage.status === 'unsupported';
  const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
  return (
    <div className="opt-storage">
      <div className="opt-row opt-between opt-meta">
        <span>Watch storage</span>
        <span>
          {unreadable
            ? storage.status
            : `${mib(storage.usedBytes)} of ${mib(storage.budgetBytes)} MiB`}
        </span>
      </div>
      <div className={`opt-bar ${storage.status === 'ok' ? '' : 'opt-bar-error'}`}>
        <div
          style={{ width: `${Math.min(100, (storage.usedBytes / storage.budgetBytes) * 100)}%` }}
        />
      </div>
    </div>
  );
}

const STORAGE_CODE = {
  full: 'WATCH_STORE_CAPACITY_EXCEEDED',
  'write-failed': 'WATCH_STORE_FAILED',
  unreadable: 'WATCH_STORE_UNREADABLE',
  unsupported: 'WATCH_STORE_VERSION_UNSUPPORTED',
} as const;

function StorageNotice({ storage }: { storage: WatchListResult['storage'] }) {
  if (storage.status === 'ok') return null;
  const code = STORAGE_CODE[storage.status];
  const copy = FAILURE_PRESENTATION[code];
  return (
    <div className="opt-banner opt-banner-error">
      <strong>Watches stopped.</strong> {copy.title}. {copy.explanation} Saved Watch data was not
      dropped or reset.
      {copy.actions.includes('copy-diagnostics') && (
        <DiagnosticsPreview failure={watchFailure(code)} />
      )}
    </div>
  );
}

function OptionList<T extends string>({
  all,
  chosen,
  label,
  note,
  onToggle,
}: {
  all: readonly T[];
  chosen: readonly T[];
  label: Record<T, string>;
  note: (value: T) => string;
  onToggle: (value: T) => void;
}) {
  return (
    <div className="opt-option-list">
      {all.map(value => {
        const checked = chosen.includes(value);
        return (
          <label key={value} className="opt-option">
            <input
              type="checkbox"
              checked={checked}
              disabled={checked && chosen.length === 1}
              onChange={() => onToggle(value)}
            />
            <span>
              {label[value]}
              <span className="opt-meta">{note(value)}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

const actionNote = (chosen: readonly WatchAction[]) => (action: WatchAction) =>
  action === 'collect' && !chosen.includes('collect')
    ? 'Off. Existing inbox entries stay until they expire or you remove them.'
    : ACTION_NOTE[action];

function FindAccount({
  login,
  onFound,
}: {
  login: InstagramLogin;
  onFound: (preview: WatchPreviewResponse) => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WatchFailure>();
  return (
    <form
      className="opt-add"
      onSubmit={event => {
        event.preventDefault();
        setBusy(true);
        void sendMessage({ type: 'WATCH_PREVIEW', target: input.trim(), login }).then(preview => {
          setBusy(false);
          setFailure(preview.failure);
          if (preview.account) onFound(preview);
        });
      }}
    >
      <input
        className="url-input"
        placeholder="@username or instagram.com profile URL"
        value={input}
        onChange={event => setInput(event.target.value)}
      />
      {failure && <FailureNotice failure={failure} />}
      <button className="opt-btn opt-primary" disabled={!input.trim() || busy}>
        {busy ? 'Finding…' : 'Find account'}
      </button>
    </form>
  );
}

function NewWatchForm({
  username,
  onRun,
  onChange,
}: {
  username: string;
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [kinds, setKinds] = useState<readonly WatchKind[]>(['posts', 'stories']);
  const [actions, setActions] = useState<readonly WatchAction[]>(['notify', 'collect']);
  const [accepted, setAccepted] = useState(false);
  const [failure, setFailure] = useState<WatchFailure>();
  return (
    <form
      className="opt-add"
      onSubmit={event => {
        event.preventDefault();
        askToNotify(actions);
        setBusy(true);
        void onRun(
          WatchAdd.make({
            target: username,
            kinds: ordered(WATCH_KINDS, kinds),
            actions: ordered(WATCH_ACTIONS, actions),
            acceptUnattended: accepted,
          })
        ).then(next => {
          setBusy(false);
          setFailure(next);
        });
      }}
    >
      <div className="opt-row">
        <div className="opt-account-text">
          <span>@{username}</span>
          <span className="opt-meta">
            Followed by account ID, so a rename keeps this Watch on the same account.
          </span>
        </div>
        <button type="button" className="opt-btn opt-ghost" onClick={onChange}>
          Change
        </button>
      </div>
      <span className="opt-label">Watch for</span>
      <OptionList
        all={WATCH_KINDS}
        chosen={kinds}
        label={KIND_LABEL}
        note={kind => KIND_NOTE[kind]}
        onToggle={kind => setKinds(toggled(kinds, kind))}
      />
      <span className="opt-label">When something new appears</span>
      <OptionList
        all={WATCH_ACTIONS}
        chosen={actions}
        label={ACTION_LABEL}
        note={actionNote(actions)}
        onToggle={action => setActions(toggled(actions, action))}
      />
      <p className="opt-note">
        The first check records what is already there and acts on nothing. Checks run only while
        your browser is open, with a catch-up check when it starts.
      </p>
      <label className="opt-option opt-disclosure">
        <input
          type="checkbox"
          checked={accepted}
          onChange={event => setAccepted(event.target.checked)}
        />
        <span>{UNATTENDED_DISCLOSURE}</span>
      </label>
      {failure && <FailureNotice failure={failure} />}
      <button className="opt-btn opt-primary" disabled={!accepted || busy}>
        Add Watch
      </button>
    </form>
  );
}

/**
 * Picks the owning login when one is linked, resolves an account as that login, then asks for
 * kinds, actions, and the disclosure acknowledgement.
 */
function AddWatchFlow({
  logins,
  onRun,
  onOpen,
}: {
  logins: Logins;
  onRun: Run;
  onOpen: (watchId: string) => void;
}) {
  const [login, setLogin] = useLoginChoice(logins);
  const [preview, setPreview] = useState<WatchPreviewResponse>();
  return (
    <>
      <LoginPicker
        logins={logins}
        login={login}
        disabled={false}
        onChange={next => {
          setLogin(next);
          setPreview(undefined);
        }}
      />
      {preview?.account ? (
        <FoundAccount
          preview={preview}
          onRun={command => onRun(command, login)}
          onChange={() => setPreview(undefined)}
          onOpen={onOpen}
        />
      ) : (
        <FindAccount key={login} login={login} onFound={setPreview} />
      )}
    </>
  );
}

function FoundAccount({
  preview: { account, existing },
  onRun,
  onChange,
  onOpen,
}: {
  preview: Extract<WatchPreviewResponse, { account: object }>;
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
  onChange: () => void;
  onOpen: (watchId: string) => void;
}) {
  if (!existing)
    return <NewWatchForm username={account.username} onRun={onRun} onChange={onChange} />;
  return (
    <div className="opt-add">
      <strong>@{account.username}</strong>
      <p className="opt-note">
        You already watch this account. Each account has one Watch per login.
      </p>
      <button className="opt-btn opt-primary" onClick={() => onOpen(existing.watchId)}>
        Open its Watch
      </button>
    </div>
  );
}

function WatchSettings({
  watch,
  onRun,
  onDeleted,
}: {
  watch: WatchSummary;
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
  onDeleted: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selector = AccountIdSelector.make({ accountId: watch.accountId });
  const kinds = watch.kinds.filter(kind => kind._tag !== 'KindOff').map(kind => kind.kind);
  return (
    <>
      <span className="opt-label">Watch for</span>
      <OptionList
        all={WATCH_KINDS}
        chosen={kinds}
        label={KIND_LABEL}
        note={kind => KIND_NOTE[kind]}
        onToggle={kind =>
          void onRun(
            WatchSet.make({ watch: selector, kinds: ordered(WATCH_KINDS, toggled(kinds, kind)) })
          )
        }
      />
      <span className="opt-label">When something new appears</span>
      <OptionList
        all={WATCH_ACTIONS}
        chosen={watch.actions}
        label={ACTION_LABEL}
        note={actionNote(watch.actions)}
        onToggle={action => {
          const next = ordered(WATCH_ACTIONS, toggled(watch.actions, action));
          if (!watch.actions.includes('notify')) askToNotify(next);
          void onRun(WatchSet.make({ watch: selector, actions: next }));
        }}
      />
      <span className="opt-label">Watch</span>
      <div className="opt-col">
        <button
          className="opt-btn"
          onClick={() =>
            void onRun(
              WatchLifecycle.make({
                operation: watch.enabled ? 'pause' : 'resume',
                watches: [selector],
              })
            )
          }
        >
          {watch.enabled ? 'Pause checks' : 'Resume checks'}
        </button>
        {watch.enabled && (
          <p className="opt-meta">
            Pausing keeps baselines and the inbox. Resuming catches up on the last 30 days.
          </p>
        )}
        <button className="opt-btn opt-danger" onClick={() => setConfirmDelete(true)}>
          Delete Watch
        </button>
        {confirmDelete && (
          <div className="opt-banner opt-banner-error">
            Delete the Watch for @{watch.username}? Its settings, seen media, Watch inbox, and
            pending actions go away. Downloaded files and History stay. Adding it again starts a
            fresh baseline.
            <div className="opt-row">
              <button
                className="opt-btn opt-danger"
                onClick={() =>
                  void onRun(
                    WatchLifecycle.make({ operation: 'delete', watches: [selector] })
                  ).then(failure => failure || onDeleted())
                }
              >
                Delete Watch
              </button>
              <button className="opt-btn opt-ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function AttentionView({
  lists,
  onOpen,
  onRun,
}: {
  lists: readonly LoginList[];
  onOpen: (watchId: string) => void;
  onRun: Run;
}) {
  const attentionEntries = lists.flatMap(({ login, list }) =>
    list.attentionEntries.map(entry => ({ login, entry }))
  );
  const problems = lists.flatMap(({ list }) =>
    list.watches.flatMap(watch =>
      watch.kinds.flatMap(health =>
        health._tag === 'KindProblem' && watch.enabled ? [{ watch, health }] : []
      )
    )
  );
  return (
    <>
      <h1 className="opt-h1">Needs you</h1>
      {problems.length === 0 && attentionEntries.length === 0 && (
        <p className="opt-note">All clear. Nothing needs you right now.</p>
      )}
      {attentionEntries.length > 0 && <h2 className="opt-h2">Actions that need you</h2>}
      {attentionEntries.map(({ login, entry }) => (
        <RecoveryActions
          key={entry.entryId}
          entry={entry}
          onRun={command => {
            if (
              command._tag === 'WatchRecover' &&
              command.action === 'notify' &&
              command.operation === 'retry'
            )
              askToNotify(['notify']);
            void onRun(command, login);
          }}
        />
      ))}
      {problems.length > 0 && <h2 className="opt-h2">Checks that could not run</h2>}
      {problems.map(({ watch, health }) => (
        <div key={watch.watchId + health.kind} className="opt-line opt-row opt-top">
          <div className="opt-grow">
            <strong>
              <OwnerTag watchId={watch.watchId} />@{watch.username} · {KIND_LABEL[health.kind]}
            </strong>
            <span className="opt-meta">{healthText(health, watch.enabled)}</span>
          </div>
          <button className="opt-btn opt-ghost" onClick={() => onOpen(watch.watchId)}>
            Open Watch
          </button>
        </div>
      ))}
    </>
  );
}

const HELD_NOTE: Record<HeldWatch['owner'], string> = {
  linked: 'Paused · link this login again to resume',
  other: 'Paused · sign in as that login to resume',
};

function rowStatus({ watch, ...owner }: PageWatch): string {
  if (owner.held) return HELD_NOTE[owner.owner];
  if (!watch.enabled) return 'Paused';
  if (watch.attentionCount > 0) return `${watch.attentionCount} need you`;
  return watch.lastCheckAt ? `Checked ${relativeTime(watch.lastCheckAt)}` : 'First check pending';
}

function WatchRow({
  item,
  avatar,
  active,
  onOpen,
}: {
  item: PageWatch;
  avatar: string | undefined;
  active: boolean;
  onOpen: () => void;
}) {
  const { watch } = item;
  const enabled = watch.enabled && !item.held;
  return (
    <button
      className={`opt-item ${active ? 'active' : ''} ${enabled ? '' : 'opt-dim'}`}
      aria-labelledby={`watch-account-${watch.watchId}`}
      onClick={onOpen}
    >
      <Avatar
        src={avatar}
        username={watch.username}
        size="md"
        placeholderHint={WATCH_AVATAR_NOTE}
      />
      <span id={`watch-account-${watch.watchId}`} className="opt-account-text opt-grow">
        <span className="opt-name" title={`@${watch.username}`}>
          @{watch.username}
        </span>
        <span className="opt-meta">
          <OwnerTag watchId={watch.watchId} />
          {rowStatus(item)}
        </span>
      </span>
      {watch.attentionCount > 0 && enabled && <span className="opt-dot" />}
    </button>
  );
}

/** One login's schedule, named by its login when both are signed in. */
interface LoginSchedule {
  readonly label: string | undefined;
  readonly schedule: WatchSchedule;
}

function NextChecks({ label, schedule }: LoginSchedule) {
  const { nextRoundAt, roundRemaining, suspended, pausedUntil, cappedUntil } = schedule;
  const held = suspended || pausedUntil !== undefined || cappedUntil !== undefined;
  if (!nextRoundAt) return null;
  return (
    <p className="opt-meta">
      {label && `${label}: `}
      {roundRemaining > 0
        ? `${held ? 'Waiting' : 'Checking'}: ${roundRemaining} left this round`
        : `Next checks around ${new Date(nextRoundAt).toLocaleString()}`}
    </p>
  );
}

/** When each login's checks run next, and how full the store is. */
function NavigationFoot({
  storage,
  schedules,
  showAvatarNote,
}: {
  storage: WatchListResult['storage'];
  schedules: readonly LoginSchedule[];
  showAvatarNote: boolean;
}) {
  return (
    <div className="opt-list-foot">
      {showAvatarNote && <p className="opt-meta">{WATCH_AVATAR_NOTE}</p>}
      {schedules.map(schedule => (
        <NextChecks key={schedule.label ?? 'main'} {...schedule} />
      ))}
      <StorageMeter storage={storage} />
    </div>
  );
}

type Filter = 'all' | InstagramLogin;

const FILTER_LABEL: Record<Filter, string> = { all: 'All', main: 'Main', linked: 'Linked' };

/** Narrows the Watch list to the Watches of one of `logins`. */
function OwnerFilter({
  logins,
  filter,
  onChange,
}: {
  logins: readonly InstagramLogin[];
  filter: Filter;
  onChange: (filter: Filter) => void;
}) {
  return (
    <div className="opt-filter" role="group" aria-label="Show Watches of">
      {(['all', ...logins] as const).map(value => (
        <button key={value} aria-pressed={filter === value} onClick={() => onChange(value)}>
          {FILTER_LABEL[value]}
        </button>
      ))}
    </div>
  );
}

/** The Watch rows, narrowed by owner while more than one owns a Watch. */
function WatchListSection({
  watches,
  manyOwners,
  avatars,
  activeWatchId,
  onGo,
}: {
  watches: readonly PageWatch[];
  manyOwners: boolean;
  avatars: WatchAvatarsResponse['watches'];
  activeWatchId: string | undefined;
  onGo: (view: View) => void;
}) {
  const owning = InstagramLogin.literals.filter(login =>
    watches.some(item => item.owner === login)
  );
  const [picked, setFilter] = useState<Filter>('all');
  const filter = picked !== 'all' && owning.includes(picked) ? picked : 'all';
  const shown = watches.filter(item => filter === 'all' || item.owner === filter);
  return (
    <>
      <span className="opt-label opt-section">Watches ({shown.length})</span>
      {manyOwners && <OwnerFilter logins={owning} filter={filter} onChange={setFilter} />}
      <div className="opt-watch-list">
        {shown.map(item => (
          <WatchRow
            key={item.watch.watchId}
            item={item}
            avatar={avatars[item.watch.watchId]}
            active={item.watch.watchId === activeWatchId}
            onOpen={() => onGo({ watchId: item.watch.watchId })}
          />
        ))}
      </div>
    </>
  );
}

function Navigation({
  page: { main, lists, watches, manyOwners, logins, schedules, attention },
  avatars,
  avatarsLoaded,
  current,
  activeWatchId,
  onGo,
  onLoginsChanged,
}: {
  page: PageModel;
  avatars: WatchAvatarsResponse;
  avatarsLoaded: boolean;
  current: View;
  activeWatchId: string | undefined;
  onGo: (view: View) => void;
  onLoginsChanged: () => void;
}) {
  const inboxCount = lists.reduce(
    (total, { list }) => total + list.watches.reduce((sum, item) => sum + item.inboxCount, 0),
    0
  );
  return (
    <nav className="opt-list">
      <div className="opt-head">
        <Title />
        <span className="opt-viewer" title="Verified from your Instagram session">
          <Avatar src={avatars.login} username={main.viewer.username} size="sm" />
          <span className="opt-meta">Instagram login</span>{' '}
          <span className="opt-name" title={`@${main.viewer.username}`}>
            @{main.viewer.username}
          </span>
        </span>
        <LoginsSection logins={logins} onChange={onLoginsChanged} />
      </div>
      <button
        className={`opt-item ${current === 'attention' ? 'active' : ''}`}
        onClick={() => onGo('attention')}
      >
        <span className="opt-icon">!</span>
        <span className="opt-grow">Needs you</span>
        {attention > 0 && <span className="opt-count opt-count-error">{attention}</span>}
      </button>
      <button
        className={`opt-item ${current === 'inbox' ? 'active' : ''}`}
        onClick={() => onGo('inbox')}
      >
        <span className="opt-icon">▤</span>
        <span className="opt-grow">All inbox</span>
        <span className="opt-count">{inboxCount}</span>
      </button>
      <WatchListSection
        watches={watches}
        manyOwners={manyOwners}
        avatars={avatars.watches}
        activeWatchId={activeWatchId}
        onGo={onGo}
      />
      <button
        className={`opt-item opt-add-item ${current === 'new' ? 'active' : ''}`}
        onClick={() => onGo('new')}
      >
        + Add Watch
      </button>
      <button
        className={`opt-item opt-add-item ${current === 'transfer' ? 'active' : ''}`}
        onClick={() => onGo('transfer')}
      >
        Export or import
      </button>
      <NavigationFoot
        storage={main.storage}
        schedules={schedules}
        showAvatarNote={
          avatarsLoaded && watches.some(({ watch }) => !avatars.watches[watch.watchId])
        }
      />
    </nav>
  );
}

/** The sign-in gate for a console whose main login the browser session no longer verifies. */
const signedOut = (loaded: Loaded): Loaded =>
  loaded.kind === 'ready'
    ? {
        kind: 'failed',
        failure: CommandFailure.make({
          failure: OperationFailure.make({ code: 'IG_NOT_AUTHENTICATED', scope: 'batch' }),
          detail: StoredWatchCount.make({
            count:
              loaded.lists.main.watches.length +
              loaded.lists.main.heldWatches.length +
              (loaded.lists.linked?.watches.length ?? 0),
          }),
        }),
      }
    : loaded;

/** Linked-login failures the Logins section already explains. */
const LINKED_GONE: ReadonlySet<FailureCode> = new Set([
  'IG_LINKED_LOGIN_MISSING',
  'IG_LINKED_LOGIN_ENDED',
]);

const linkedFailureOf = (response: WatchCommandResponse) =>
  response.failure?._tag === 'CommandFailure' && LINKED_GONE.has(response.failure.failure.code)
    ? undefined
    : response.failure;

/**
 * Both logins' verified Watch lists. `verify` asks Instagram who each login is, `refresh` rereads
 * the known logins' Watches, and a viewer change another surface records in the browser session is
 * followed. The linked list is read first, so a session it finds ended shows among the main list's
 * held Watches.
 */
function useWatchList() {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(0);
  const [observed, setObserved] = useState<
    Partial<Record<InstagramLogin, { readonly accountId: string | undefined }>>
  >({});
  const latest = useRef(0);
  const viewers = useRef<Partial<Record<InstagramLogin, WatchViewer>>>({});
  const linkedFailure = useRef<WatchFailure>(undefined);
  const verification = useRef<Promise<void>>(undefined);
  const reverify = useRef(false);

  const load = useCallback(
    async (read: (login: InstagramLogin) => Promise<WatchCommandResponse> | undefined) => {
      const request = ++latest.current;
      setPending(count => count + 1);
      try {
        const linked = await read('linked');
        const main = await read('main');
        const linkedState = await linkedLoginState();
        if (request !== latest.current || !main) return;
        if (main.failure) {
          viewers.current = {};
          setLoaded({ kind: 'failed', failure: main.failure });
        } else if (main.result._tag === 'WatchListResult') {
          const linkedList = linked?.result?._tag === 'WatchListResult' ? linked.result : undefined;
          if (linked) linkedFailure.current = linkedFailureOf(linked);
          viewers.current = {
            main: main.result.viewer,
            ...(linkedList ? { linked: linkedList.viewer } : {}),
          };
          setLoaded({
            kind: 'ready',
            lists: {
              main: main.result,
              linked: linkedList,
              linkedFailure: linkedFailure.current,
              linkedState,
            },
          });
        }
        setVersion(current => current + 1);
      } finally {
        setPending(count => count - 1);
      }
    },
    []
  );
  const verify = useCallback(() => {
    reverify.current = true;
    if (verification.current) latest.current += 1;
    verification.current ??= (async () => {
      do {
        reverify.current = false;
        await load(login => runCommand(WatchList.make(), login));
      } while (reverify.current);
    })().finally(() => {
      verification.current = undefined;
    });
    return verification.current;
  }, [load]);
  const refresh = useCallback(async () => {
    await verification.current;
    const known = viewers.current;
    if (!known.main) return;
    await load(login => {
      const viewer = known[login];
      return viewer && runRead(WatchList.make(), viewer, login);
    });
  }, [load]);

  useEffect(() => {
    const listener = (changes: StorageChanges) => {
      for (const login of InstagramLogin.literals) {
        const change = changes[VIEWER_KEYS[login]];
        if (!change) continue;
        const next = Option.getOrUndefined(decodeCachedViewer(change.newValue));
        setObserved(current => ({ ...current, [login]: { accountId: next?.accountId } }));
        if (login !== 'main' || next || !viewers.current.main) continue;
        latest.current += 1;
        viewers.current = {};
        setLoaded(signedOut);
      }
    };
    browser.sessionStorage.onChanged.addListener(listener);
    return () => {
      browser.sessionStorage.onChanged.removeListener(listener);
      reverify.current = false;
      viewers.current = {};
      latest.current += 1;
    };
  }, []);
  useEffect(() => {
    const seen = InstagramLogin.literals.flatMap(login => {
      const viewer = observed[login];
      return viewer ? [{ login, accountId: viewer.accountId }] : [];
    });
    if (pending > 0 || seen.length === 0) return;
    setObserved({});
    if (seen.some(({ login, accountId }) => accountId !== viewers.current[login]?.accountId))
      void verify();
  }, [pending, observed, verify]);

  return { loaded, version, verify, refresh };
}

const pauseChanged = (changes: StorageChanges) =>
  InstagramLogin.literals.some(login => {
    const ledger = changes[LEDGER_KEYS[login]];
    return (
      ledger &&
      decodeLedger(ledger.oldValue)?.pause?.until !== decodeLedger(ledger.newValue)?.pause?.until
    );
  });

/** The Watches console: navigation, the selected view, and the selected Watch's settings. */
export function Watches() {
  const { loaded, version, verify, refresh } = useWatchList();

  useEffect(() => {
    void verify();
    let away = document.visibilityState !== 'visible' || !document.hasFocus();
    const leave = () => {
      away = true;
    };
    const enter = () => {
      if (document.visibilityState !== 'visible' || !away) return;
      away = false;
      void verify();
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') enter();
      else leave();
    };
    window.addEventListener('blur', leave);
    window.addEventListener('focus', enter);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', enter);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [verify]);

  const ready = loaded.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    const listener = (changes: StorageChanges) => {
      if (STORE_KEY in changes || SCHEDULER_KEY in changes || pauseChanged(changes)) void refresh();
    };
    browser.storage.onChanged.addListener(listener);
    void refresh();
    return () => browser.storage.onChanged.removeListener(listener);
  }, [ready, refresh]);

  if (loaded.kind === 'loading') return <p className="opt-gate opt-meta">Loading Watches…</p>;
  if (loaded.kind === 'failed') return <LoginGate failure={loaded.failure} />;
  return (
    <Console
      key={loaded.lists.main.viewer.accountId}
      lists={loaded.lists}
      version={version}
      refresh={refresh}
      verify={verify}
    />
  );
}

/** The cached Avatars of every Watch and the main login's own, reread when `version` changes. */
function useWatchAvatars(viewerId: string, version: number) {
  const [avatars, setAvatars] = useState<WatchAvatarsResponse>();
  useEffect(() => {
    let current = true;
    void sendMessage({ type: 'WATCH_AVATARS', viewerId }).then(next => {
      if (current) setAvatars(previous => ({ ...next, login: next.login ?? previous?.login }));
    });
    return () => {
      current = false;
    };
  }, [viewerId, version]);
  return { images: avatars ?? { watches: {} }, loaded: avatars !== undefined };
}

/** When `login`'s checks run next and what holds them, followed live from storage. */
function useWatchSchedule(list: WatchListResult | undefined, login: InstagramLogin) {
  const viewerId = list?.viewer.accountId;
  const ledgerKey = LEDGER_KEYS[login];
  const [records, setRecords] = useState<{
    scheduler: SchedulerState;
    ledger: LedgerView | undefined;
    at: number;
  }>();
  useEffect(() => {
    if (!viewerId) return;
    let active = true;
    let latest = 0;
    const read = () => {
      const current = ++latest;
      void browser.storage.get([SCHEDULER_KEY, ledgerKey]).then(stored => {
        if (!active || current !== latest) return;
        setRecords({
          scheduler: decodeSchedulerState(stored[SCHEDULER_KEY]),
          ledger: decodeLedger(stored[ledgerKey]),
          at: Date.now(),
        });
      });
    };
    const listener = (changes: StorageChanges) => {
      if (SCHEDULER_KEY in changes || ledgerKey in changes) read();
    };
    browser.storage.onChanged.addListener(listener);
    read();
    return () => {
      active = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, [viewerId, ledgerKey]);
  const schedule =
    records && viewerId
      ? watchSchedule(records.scheduler, records.ledger, viewerId, records.at, login)
      : list?.schedule;
  const holdEnd = schedule?.cappedUntil ?? schedule?.pausedUntil;
  useEffect(() => {
    if (holdEnd === undefined) return;
    const timer = setTimeout(
      () => setRecords(current => current && { ...current, at: Date.now() }),
      Math.max(0, holdEnd - Date.now())
    );
    return () => clearTimeout(timer);
  }, [holdEnd]);
  return schedule;
}

/** Why one login's unattended checks are not running right now, if something holds them back. */
function ScheduleNotice({ label, schedule }: LoginSchedule) {
  const named = label ? `${label}: ` : '';
  if (schedule.suspended)
    return (
      <p className="opt-banner opt-banner-error">
        <strong>{named}Watches stopped.</strong> Instagram refused the signed-in session. Sign in to
        Instagram again, then return to this page to resume checks.
      </p>
    );
  if (schedule.pausedUntil)
    return (
      <p className="opt-banner opt-banner-error">
        <strong>{named}Watches paused.</strong> Instagram rate limited a Watch request, so Watch
        checks wait until{' '}
        {new Date(schedule.cappedUntil ?? schedule.pausedUntil).toLocaleTimeString()}. Your own
        downloads still go first.
      </p>
    );
  if (schedule.cappedUntil)
    return (
      <p className="opt-banner">
        <strong>{named}Watches waiting.</strong> Instagram requests in the last hour, your own
        included, reached the hourly limit. Watch checks resume around{' '}
        {new Date(schedule.cappedUntil).toLocaleTimeString()}, or later if more requests are made.
      </p>
    );
  return null;
}

const HELD_DETAIL: Record<HeldWatch['owner'], string> = {
  linked:
    'Your linked login was signed out, so this Watch is paused. Link that login again to resume it.',
  other:
    'Another Instagram login owns this Watch, so it is paused. Sign in to Instagram as that login to resume it.',
};

/** A Watch whose owner is not signed in. It is shown, never changed. */
function HeldDetail({
  item: { owner, watch },
  avatar,
}: {
  item: Extract<PageWatch, { held: true }>;
  avatar: string | undefined;
}) {
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
          <span className="opt-meta">{OWNER_LABEL[owner]}</span>
        </div>
      </div>
      <p className="opt-banner">{HELD_DETAIL[owner]} Its inbox and baselines are kept.</p>
    </>
  );
}

/** The selected Watch: its detail as its owner, or what holds it. */
function SelectedWatch({
  item,
  lists,
  avatar,
  version,
  onChanged,
}: {
  item: PageWatch;
  lists: readonly LoginList[];
  avatar: string | undefined;
  version: number;
  onChanged: () => void;
}) {
  if (item.held) return <HeldDetail item={item} avatar={avatar} />;
  const owner = lists.find(({ login }) => login === item.owner);
  return owner ? (
    <WatchDetail
      key={item.watch.watchId}
      owner={owner}
      watch={item.watch}
      avatar={avatar}
      version={version}
      onChanged={onChanged}
    />
  ) : null;
}

/** What holds Watches back right now: the store, each login's schedule, and the last failure. */
function Notices({
  page,
  actionFailure,
}: {
  page: PageModel;
  actionFailure: WatchFailure | undefined;
}) {
  return (
    <>
      <StorageNotice storage={page.main.storage} />
      {page.schedules.map(schedule => (
        <ScheduleNotice key={schedule.label ?? 'main'} {...schedule} />
      ))}
      {page.linkedFailure && <FailureNotice label="Linked login" failure={page.linkedFailure} />}
      {actionFailure && <FailureNotice failure={actionFailure} />}
    </>
  );
}

function Feed({
  page,
  current,
  selected,
  avatars,
  actionFailure,
  version,
  onGo,
  onRun,
  onSend,
  onChanged,
}: {
  page: PageModel;
  current: View;
  selected: PageWatch | undefined;
  avatars: WatchAvatarsResponse['watches'];
  actionFailure: WatchFailure | undefined;
  version: number;
  onGo: (view: View) => void;
  onRun: Run;
  onSend: (command: WatchCommand, login: InstagramLogin) => Promise<WatchCommandResponse>;
  onChanged: () => void;
}) {
  const { lists, logins } = page;
  const open = (watchId: string) => onGo({ watchId });
  return (
    <section key={typeof current === 'object' ? current.watchId : current} className="opt-feed">
      <Notices page={page} actionFailure={actionFailure} />
      {current === 'attention' && <AttentionView lists={lists} onRun={onRun} onOpen={open} />}
      {current === 'inbox' && <AllInbox lists={lists} version={version} />}
      {current === 'new' && (
        <>
          <h1 className="opt-h1">Add Watch</h1>
          <AddWatchFlow logins={logins} onRun={onRun} onOpen={open} />
        </>
      )}
      {current === 'transfer' && <WatchTransfer lists={lists} logins={logins} onSend={onSend} />}
      {selected && (
        <SelectedWatch
          item={selected}
          lists={lists}
          avatar={avatars[selected.watch.watchId]}
          version={version}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

/**
 * Both logins' lists as the page shows them: every Watch with its owner, each login's schedule,
 * and how many things need the person.
 */
function usePageModel({ main, linked, linkedFailure, linkedState }: Lists) {
  const lists = useMemo<readonly LoginList[]>(
    () => [
      { login: 'main', list: main },
      ...(linked ? [{ login: 'linked', list: linked } satisfies LoginList] : []),
    ],
    [main, linked]
  );
  const watches = useMemo(() => pageWatches(lists, main.heldWatches), [lists, main]);
  const mainSchedule = useWatchSchedule(main, 'main') ?? main.schedule;
  const linkedSchedule = useWatchSchedule(linked, 'linked');
  const ownerOf = (watchId: string | undefined) =>
    watches.find(item => item.watch.watchId === watchId);
  return {
    main,
    lists,
    watches,
    linkedFailure,
    ownerOf,
    loginOf: (watchId: string | undefined): InstagramLogin => {
      const item = ownerOf(watchId);
      return item && !item.held ? item.owner : 'main';
    },
    manyOwners: new Set(watches.map(item => item.owner)).size > 1,
    logins: {
      state: linkedState,
      names: { main: main.viewer.username, ...(linked ? { linked: linked.viewer.username } : {}) },
    } satisfies Logins,
    schedules: [
      { label: linked && OWNER_LABEL.main, schedule: mainSchedule },
      ...(linkedSchedule ? [{ label: OWNER_LABEL.linked, schedule: linkedSchedule }] : []),
    ] satisfies LoginSchedule[],
    // Every list counts the shared store's problem, so the page counts it once, from the main list.
    attention: lists.reduce(
      (total, { list }) => total + list.attentionCount - (list.storage.status === 'ok' ? 0 : 1),
      main.storage.status === 'ok' ? 0 : 1
    ),
  };
}

type PageModel = ReturnType<typeof usePageModel>;

function Inspector({
  exporter,
  selected,
  onRun,
  onDeleted,
}: {
  exporter: ReturnType<typeof useInboxExport>;
  selected: PageWatch | undefined;
  onRun: Run;
  onDeleted: () => void;
}) {
  if (exporter.active) return <InboxExportControls value={exporter} />;
  if (!selected) return <p className="opt-meta">Pick a Watch on the left to change it.</p>;
  if (selected.held)
    return <p className="opt-meta">Sign in as the login that owns this Watch to change it.</p>;
  return (
    <WatchSettings
      watch={selected.watch}
      onRun={command => onRun(command, selected.owner)}
      onDeleted={onDeleted}
    />
  );
}

function Console({
  lists,
  version,
  refresh,
  verify,
}: {
  lists: Lists;
  version: number;
  refresh: () => Promise<void>;
  verify: () => Promise<void>;
}) {
  const page = usePageModel(lists);
  const { main, ownerOf, manyOwners, attention } = page;
  const exporter = useInboxExport(() => void refresh(), page.loginOf);
  const { images: avatars, loaded: avatarsLoaded } = useWatchAvatars(
    main.viewer.accountId,
    version
  );
  const [view, setView] = useState<View | undefined>(linkedView);
  const [actionFailure, setActionFailure] = useState<WatchFailure>();
  const known = typeof view === 'object' && !ownerOf(view.watchId) ? undefined : view;
  const current = known ?? (attention > 0 ? 'attention' : 'inbox');
  const selected = typeof current === 'object' ? ownerOf(current.watchId) : undefined;

  const go = (next: View) => {
    exporter.clear();
    setActionFailure(undefined);
    setView(next);
  };
  const send = async (command: WatchCommand, login: InstagramLogin) => {
    const response = await runCommand(command, login);
    setActionFailure(response.failure);
    await refresh();
    return response;
  };
  const run: Run = async (command, login) => {
    const response = await send(command, login);
    if (!response.failure && response.result._tag === 'WatchAddResult')
      setView({ watchId: response.result.watch.watchId });
    return response.failure;
  };

  return (
    <OwnerTagContext.Provider value={watchId => (manyOwners ? ownerOf(watchId)?.owner : undefined)}>
      <InboxExportContext.Provider value={exporter}>
        <div className="opt-console">
          <Navigation
            page={page}
            avatars={avatars}
            avatarsLoaded={avatarsLoaded}
            current={current}
            activeWatchId={selected?.watch.watchId}
            onGo={go}
            onLoginsChanged={() => void verify()}
          />

          <Feed
            page={page}
            current={current}
            selected={selected}
            avatars={avatars.watches}
            actionFailure={actionFailure}
            version={version}
            onGo={go}
            onRun={run}
            onSend={send}
            onChanged={() => void refresh()}
          />

          <section className="opt-inspector">
            <Inspector
              exporter={exporter}
              selected={selected}
              onRun={run}
              onDeleted={() => go('inbox')}
            />
          </section>
        </div>
      </InboxExportContext.Provider>
    </OwnerTagContext.Provider>
  );
}
