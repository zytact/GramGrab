import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccountIdSelector,
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
  type WatchSummary,
  type WatchViewer,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type {
  WatchCommandResponse,
  WatchAvatarsResponse,
  WatchFailure,
  WatchPreviewResponse,
} from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { watchFailure } from '../errors/contracts.ts';
import { buildWatchDiagnostics } from '../errors/diagnostics.ts';
import { browser, type StorageChanges } from '../lib/browser.ts';
import { LEDGER_KEY, storedPauseUntil } from '../instagram/request-state.ts';
import { STORE_KEY } from '../watch/contracts.ts';
import { SCHEDULER_KEY } from '../watch/schedule-state.ts';
import { ACTION_LABEL, ACTION_NOTE, KIND_LABEL, KIND_NOTE, relativeTime } from './copy.ts';
import { InboxExportContext, InboxExportControls, useInboxExport } from './inbox-export.tsx';
import { RecoveryActions } from './recovery-actions.tsx';
import { AllInbox, WatchDetail, healthText, runCommand, runRead } from './watch-detail.tsx';
import { Avatar } from './avatar.tsx';

type View = 'attention' | 'inbox' | 'new' | { readonly watchId: string };

/** A notification opens `#watch=<id>`; the Watch shows only if this login owns it. */
const linkedView = (): View | undefined => {
  const watchId = new URLSearchParams(location.hash.slice(1)).get('watch');
  return watchId ? { watchId } : undefined;
};

/**
 * Asks for notification permission when notify is chosen. It must run inside the click, before
 * any other await. A refusal is not an error here: delivery records it on the entries it affects.
 */
const askToNotify = (actions: readonly WatchAction[]) => {
  if (actions.includes('notify'))
    void browser.permissions.request({ permissions: ['notifications'] }).catch(() => false);
};

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly list: WatchListResult }
  | { readonly kind: 'failed'; readonly failure: WatchFailure };

const toggled = <T,>(values: readonly T[], value: T): T[] =>
  values.includes(value) ? values.filter(item => item !== value) : [...values, value];

const ordered = <T extends string>(all: readonly T[], chosen: readonly T[]) =>
  all.filter(value => chosen.includes(value));

function FailureNotice({ failure }: { failure: WatchFailure }) {
  if (failure._tag === 'ValidationFailure')
    return <p className="opt-banner opt-banner-error">{failure.message}</p>;
  const copy = FAILURE_PRESENTATION[failure.failure.code];
  return (
    <p className="opt-banner opt-banner-error">
      <strong>{copy.title}.</strong> {copy.explanation}
    </p>
  );
}

/** The page shown when GramGrab cannot confirm who is signed in. Nothing owner-bound appears. */
function LoginGate({ failure }: { failure: WatchFailure }) {
  const stored =
    failure._tag === 'CommandFailure' && failure.detail?._tag === 'StoredWatchCount'
      ? failure.detail.count
      : 0;
  const signedOut =
    failure._tag === 'CommandFailure' && failure.failure.code === 'IG_NOT_AUTHENTICATED';
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

/** Shows the structural-only report before the person copies it. */
function DiagnosticsPreview({ code }: { code: (typeof STORAGE_CODE)[keyof typeof STORAGE_CODE] }) {
  const [json, setJson] = useState<string>();
  if (!json)
    return (
      <button
        className="opt-btn"
        onClick={() =>
          setJson(
            buildWatchDiagnostics({
              extensionVersion: browser.runtime.getManifest().version ?? '0.0.0',
              userAgent: navigator.userAgent,
              failure: watchFailure(code),
            })
          )
        }
      >
        Preview diagnostics
      </button>
    );
  return (
    <div className="opt-col">
      <p className="opt-note">
        This contains only the extension version, capture time, normalized browser details, and the
        structured failure code. It excludes accounts, usernames, media, and anything saved in your
        Watches.
      </p>
      <pre className="diagnostics-preview">{json}</pre>
      <button className="opt-btn" onClick={() => void navigator.clipboard.writeText(json)}>
        Copy diagnostics
      </button>
    </div>
  );
}

function StorageNotice({ storage }: { storage: WatchListResult['storage'] }) {
  if (storage.status === 'ok') return null;
  const code = STORAGE_CODE[storage.status];
  const copy = FAILURE_PRESENTATION[code];
  return (
    <div className="opt-banner opt-banner-error">
      <strong>Watches stopped.</strong> {copy.title}. {copy.explanation} Saved Watch data was not
      dropped or reset.
      {copy.actions.includes('copy-diagnostics') && <DiagnosticsPreview code={code} />}
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

function FindAccount({ onFound }: { onFound: (preview: WatchPreviewResponse) => void }) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<WatchFailure>();
  return (
    <form
      className="opt-add"
      onSubmit={event => {
        event.preventDefault();
        setBusy(true);
        void sendMessage({ type: 'WATCH_PREVIEW', target: input.trim() }).then(preview => {
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

/** Resolves an account first, then asks for kinds, actions, and the disclosure acknowledgement. */
function AddWatchFlow({
  onRun,
  onOpen,
}: {
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
  onOpen: (watchId: string) => void;
}) {
  const [preview, setPreview] = useState<WatchPreviewResponse>();
  if (!preview?.account) return <FindAccount onFound={setPreview} />;
  const { account, existing } = preview;
  if (!existing)
    return (
      <NewWatchForm
        username={account.username}
        onRun={onRun}
        onChange={() => setPreview(undefined)}
      />
    );
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
  list,
  onOpen,
  onRun,
}: {
  list: WatchListResult;
  onOpen: (watchId: string) => void;
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
}) {
  const { watches, attentionEntries } = list;
  const problems = watches.flatMap(watch =>
    watch.kinds.flatMap(health =>
      health._tag === 'KindProblem' && watch.enabled ? [{ watch, health }] : []
    )
  );
  return (
    <>
      <h1 className="opt-h1">Needs you</h1>
      {problems.length === 0 && attentionEntries.length === 0 && (
        <p className="opt-note">All clear. Nothing needs you right now.</p>
      )}
      {attentionEntries.length > 0 && <h2 className="opt-h2">Actions that need you</h2>}
      {attentionEntries.map(entry => (
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
            void onRun(command);
          }}
        />
      ))}
      {problems.length > 0 && <h2 className="opt-h2">Checks that could not run</h2>}
      {problems.map(({ watch, health }) => (
        <div key={watch.watchId + health.kind} className="opt-line opt-row opt-top">
          <div className="opt-grow">
            <strong>
              @{watch.username} · {KIND_LABEL[health.kind]}
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

function WatchRow({
  watch,
  avatar,
  active,
  onOpen,
}: {
  watch: WatchSummary;
  avatar: string | undefined;
  active: boolean;
  onOpen: () => void;
}) {
  const attention = watch.attentionCount;
  return (
    <button
      className={`opt-item ${active ? 'active' : ''} ${watch.enabled ? '' : 'opt-dim'}`}
      onClick={onOpen}
    >
      <Avatar src={avatar} username={watch.username} size="md" />
      <span className="opt-account-text opt-grow">
        <span>@{watch.username}</span>
        <span className="opt-meta">
          {!watch.enabled
            ? 'Paused'
            : attention > 0
              ? `${attention} need you`
              : watch.lastCheckAt
                ? `Checked ${relativeTime(watch.lastCheckAt)}`
                : 'First check pending'}
        </span>
      </span>
      {attention > 0 && watch.enabled && <span className="opt-dot" />}
    </button>
  );
}

/** Other logins' Watches, when checks run next, and how full the store is. */
function NavigationFoot({ list }: { list: WatchListResult }) {
  const others = list.otherLoginWatchCount;
  const { nextRoundAt, roundRemaining } = list.schedule;
  return (
    <div className="opt-list-foot">
      {others > 0 && (
        <p className="opt-banner">
          {others} {others === 1 ? 'Watch belongs' : 'Watches belong'} to another Instagram login.{' '}
          {others === 1 ? 'It is' : 'They are'} paused and hidden until that login signs in again.
        </p>
      )}
      {nextRoundAt && (
        <p className="opt-meta">
          {roundRemaining > 0
            ? `Checking: ${roundRemaining} left this round`
            : `Next checks around ${new Date(nextRoundAt).toLocaleString()}`}
        </p>
      )}
      <StorageMeter storage={list.storage} />
    </div>
  );
}

function Navigation({
  list,
  avatars,
  current,
  attention,
  activeWatchId,
  onGo,
}: {
  list: WatchListResult;
  avatars: WatchAvatarsResponse;
  current: View;
  attention: number;
  activeWatchId: string | undefined;
  onGo: (view: View) => void;
}) {
  const inboxCount = list.watches.reduce((total, item) => total + item.inboxCount, 0);
  return (
    <nav className="opt-list">
      <div className="opt-head">
        <Title />
        <span className="opt-viewer" title="Verified from your Instagram session">
          <Avatar src={avatars.login} username={list.viewer.username} size="sm" />
          <span className="opt-meta">Instagram login</span> @{list.viewer.username}
        </span>
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
      <span className="opt-label opt-section">Watches ({list.watches.length})</span>
      {list.watches.map(item => (
        <WatchRow
          key={item.watchId}
          watch={item}
          avatar={avatars.watches[item.watchId]}
          active={item.watchId === activeWatchId}
          onOpen={() => onGo({ watchId: item.watchId })}
        />
      ))}
      <button
        className={`opt-item opt-add-item ${current === 'new' ? 'active' : ''}`}
        onClick={() => onGo('new')}
      >
        + Add Watch
      </button>
      <NavigationFoot list={list} />
    </nav>
  );
}

/** The Watches console: navigation, the selected view, and the selected Watch's settings. */
export function Watches() {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [version, setVersion] = useState(0);
  const latest = useRef(0);
  const viewer = useRef<WatchViewer>(undefined);
  const verification = useRef<Promise<void>>(undefined);
  const reverify = useRef(false);

  const load = useCallback(async (send: () => Promise<WatchCommandResponse>) => {
    const request = ++latest.current;
    const response = await send();
    if (request !== latest.current) return;
    if (response.failure) {
      viewer.current = undefined;
      setLoaded({ kind: 'failed', failure: response.failure });
    } else if (response.result._tag === 'WatchListResult') {
      viewer.current = response.result.viewer;
      setLoaded({ kind: 'ready', list: response.result });
    }
    setVersion(current => current + 1);
  }, []);
  const verify = useCallback(() => {
    reverify.current = true;
    if (verification.current) latest.current += 1;
    verification.current ??= (async () => {
      do {
        reverify.current = false;
        await load(() => runCommand(WatchList.make()));
      } while (reverify.current);
    })().finally(() => {
      verification.current = undefined;
    });
    return verification.current;
  }, [load]);
  const refresh = useCallback(async () => {
    await verification.current;
    const known = viewer.current;
    if (known) await load(() => runRead(WatchList.make(), known));
  }, [load]);

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
      reverify.current = false;
      viewer.current = undefined;
      latest.current += 1;
    };
  }, [verify]);

  const ready = loaded.kind === 'ready';
  useEffect(() => {
    if (!ready) return;
    const listener = (changes: StorageChanges) => {
      const ledger = changes[LEDGER_KEY];
      if (
        STORE_KEY in changes ||
        SCHEDULER_KEY in changes ||
        (ledger && storedPauseUntil(ledger.oldValue) !== storedPauseUntil(ledger.newValue))
      )
        void refresh();
    };
    browser.storage.onChanged.addListener(listener);
    void refresh();
    return () => browser.storage.onChanged.removeListener(listener);
  }, [ready, refresh]);

  if (loaded.kind === 'loading') return <p className="opt-gate opt-meta">Loading Watches…</p>;
  if (loaded.kind === 'failed') return <LoginGate failure={loaded.failure} />;
  return (
    <Console
      key={loaded.list.viewer.accountId}
      list={loaded.list}
      version={version}
      refresh={refresh}
    />
  );
}

/** The cached Avatars of the login's Watches and the login's own, reread whenever `version` changes. */
function useWatchAvatars(viewerId: string, version: number): WatchAvatarsResponse {
  const [avatars, setAvatars] = useState<WatchAvatarsResponse>({ watches: {} });
  useEffect(() => {
    let current = true;
    void sendMessage({ type: 'WATCH_AVATARS', viewerId }).then(next => {
      if (current) setAvatars(previous => ({ ...next, login: next.login ?? previous.login }));
    });
    return () => {
      current = false;
    };
  }, [viewerId, version]);
  return avatars;
}

/** Why unattended checks are not running right now, if something holds them back. */
function ScheduleNotice({ schedule }: { schedule: WatchListResult['schedule'] }) {
  if (schedule.suspended)
    return (
      <p className="opt-banner opt-banner-error">
        <strong>Watches stopped.</strong> Instagram refused the signed-in session. Sign in to
        Instagram again, then return to this page to resume checks.
      </p>
    );
  if (schedule.pausedUntil)
    return (
      <p className="opt-banner opt-banner-error">
        <strong>Watches paused.</strong> Instagram rate limited a Watch request, so Watch checks
        wait until {new Date(schedule.pausedUntil).toLocaleTimeString()}. Your own downloads still
        go first.
      </p>
    );
  return null;
}

function Feed({
  list,
  current,
  watch,
  avatars,
  actionFailure,
  version,
  onGo,
  onRun,
  onChanged,
}: {
  list: WatchListResult;
  current: View;
  watch: WatchSummary | undefined;
  avatars: WatchAvatarsResponse['watches'];
  actionFailure: WatchFailure | undefined;
  version: number;
  onGo: (view: View) => void;
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
  onChanged: () => void;
}) {
  return (
    <section className="opt-feed">
      <StorageNotice storage={list.storage} />
      <ScheduleNotice schedule={list.schedule} />
      {actionFailure && <FailureNotice failure={actionFailure} />}
      {current === 'attention' && (
        <AttentionView list={list} onRun={onRun} onOpen={id => onGo({ watchId: id })} />
      )}
      {current === 'inbox' && (
        <AllInbox viewer={list.viewer} version={version} onChanged={onChanged} />
      )}
      {current === 'new' && (
        <>
          <h1 className="opt-h1">Add Watch</h1>
          <AddWatchFlow onRun={onRun} onOpen={id => onGo({ watchId: id })} />
        </>
      )}
      {watch && (
        <WatchDetail
          key={watch.watchId}
          viewer={list.viewer}
          watch={watch}
          avatar={avatars[watch.watchId]}
          version={version}
          onChanged={onChanged}
        />
      )}
    </section>
  );
}

function Console({
  list,
  version,
  refresh,
}: {
  list: WatchListResult;
  version: number;
  refresh: () => Promise<void>;
}) {
  const exporter = useInboxExport(() => void refresh());
  const avatars = useWatchAvatars(list.viewer.accountId, version);
  const [view, setView] = useState<View | undefined>(linkedView);
  const [actionFailure, setActionFailure] = useState<WatchFailure>();
  const attention = list.attentionCount;
  const known =
    typeof view === 'object' && !list.watches.some(watch => watch.watchId === view.watchId)
      ? undefined
      : view;
  const current = known ?? (attention > 0 ? 'attention' : 'inbox');
  const watch =
    typeof current === 'object'
      ? list.watches.find(candidate => candidate.watchId === current.watchId)
      : undefined;

  const go = (next: View) => {
    exporter.clear();
    setActionFailure(undefined);
    setView(next);
  };
  const run = async (command: WatchCommand) => {
    const response = await runCommand(command);
    setActionFailure(response.failure);
    await refresh();
    if (!response.failure && response.result._tag === 'WatchAddResult')
      setView({ watchId: response.result.watch.watchId });
    return response.failure;
  };

  return (
    <InboxExportContext.Provider value={exporter}>
      <div className="opt-console">
        <Navigation
          list={list}
          avatars={avatars}
          current={current}
          attention={attention}
          activeWatchId={watch?.watchId}
          onGo={go}
        />

        <Feed
          list={list}
          current={current}
          watch={watch}
          avatars={avatars.watches}
          actionFailure={actionFailure}
          version={version}
          onGo={go}
          onRun={run}
          onChanged={() => void refresh()}
        />

        <section className="opt-inspector">
          {exporter.active ? (
            <InboxExportControls value={exporter} />
          ) : watch ? (
            <WatchSettings watch={watch} onRun={run} onDeleted={() => go('inbox')} />
          ) : (
            <p className="opt-meta">Pick a Watch on the left to change it.</p>
          )}
        </section>
      </div>
    </InboxExportContext.Provider>
  );
}
