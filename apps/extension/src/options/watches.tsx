import { useCallback, useEffect, useState } from 'react';
import {
  AccountIdSelector,
  UNATTENDED_DISCLOSURE,
  WATCH_ACTIONS,
  WATCH_KINDS,
  WatchAdd,
  WatchLifecycle,
  WatchList,
  WatchSet,
  type KindHealth,
  type WatchAction,
  type WatchCommand,
  type WatchKind,
  type WatchListResult,
  type WatchSummary,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type { WatchFailure, WatchPreviewResponse } from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { watchFailure } from '../errors/contracts.ts';
import { buildWatchDiagnostics } from '../errors/diagnostics.ts';
import { browser } from '../lib/browser.ts';
import { ACTION_LABEL, ACTION_NOTE, KIND_LABEL, KIND_NOTE, relativeTime } from './copy.ts';

type View = 'attention' | 'inbox' | 'new' | { readonly watchId: string };

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly list: WatchListResult }
  | { readonly kind: 'failed'; readonly failure: WatchFailure };

const runCommand = (command: WatchCommand) => sendMessage({ type: 'WATCH_COMMAND', command });

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

function healthText(health: KindHealth, enabled: boolean): string {
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
      return enabled ? `Checked ${relativeTime(health.lastSuccessAt)}` : 'Paused';
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
        onToggle={action =>
          void onRun(
            WatchSet.make({
              watch: selector,
              actions: ordered(WATCH_ACTIONS, toggled(watch.actions, action)),
            })
          )
        }
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
  watches,
  onOpen,
}: {
  watches: readonly WatchSummary[];
  onOpen: (watchId: string) => void;
}) {
  const problems = watches.flatMap(watch =>
    watch.kinds.flatMap(health =>
      health._tag === 'KindProblem' && watch.enabled ? [{ watch, health }] : []
    )
  );
  return (
    <>
      <h1 className="opt-h1">Needs you</h1>
      {problems.length === 0 && <p className="opt-note">All clear. Nothing needs you right now.</p>}
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
  active,
  onOpen,
}: {
  watch: WatchSummary;
  active: boolean;
  onOpen: () => void;
}) {
  const problems = watch.kinds.filter(kind => kind._tag === 'KindProblem').length;
  const attention = watch.attentionCount + problems;
  return (
    <button
      className={`opt-item ${active ? 'active' : ''} ${watch.enabled ? '' : 'opt-dim'}`}
      onClick={onOpen}
    >
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

function Navigation({
  list,
  current,
  attention,
  activeWatchId,
  onGo,
}: {
  list: WatchListResult;
  current: View;
  attention: number;
  activeWatchId: string | undefined;
  onGo: (view: View) => void;
}) {
  const inboxCount = list.watches.reduce((total, item) => total + item.inboxCount, 0);
  const others = list.otherLoginWatchCount;
  return (
    <nav className="opt-list">
      <div className="opt-head">
        <Title />
        <span className="opt-viewer" title="Verified from your Instagram session">
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
      <div className="opt-list-foot">
        {others > 0 && (
          <p className="opt-banner">
            {list.otherLoginWatchCount}{' '}
            {list.otherLoginWatchCount === 1 ? 'Watch belongs' : 'Watches belong'} to another
            Instagram login. {list.otherLoginWatchCount === 1 ? 'It is' : 'They are'} paused and
            hidden until that login signs in again.
          </p>
        )}
        <StorageMeter storage={list.storage} />
      </div>
    </nav>
  );
}

function WatchDetail({ watch }: { watch: WatchSummary }) {
  return (
    <>
      <div className="opt-account-text">
        <span className="opt-h1">@{watch.username}</span>
        {watch.formerUsername && <span className="opt-meta">was @{watch.formerUsername}</span>}
      </div>
      {!watch.enabled && (
        <p className="opt-banner">
          Paused. The inbox and baselines are kept. Resuming catches up on the last 30 days.
        </p>
      )}
      <KindHealthList watch={watch} />
    </>
  );
}

/** Needs-you items: recorded attention plus every enabled kind's check problem. */
const attentionTotal = (list: WatchListResult) =>
  list.attentionCount +
  list.watches
    .filter(watch => watch.enabled)
    .flatMap(watch => watch.kinds)
    .filter(kind => kind._tag === 'KindProblem').length;

/** The Watches console: navigation, the selected view, and the selected Watch's settings. */
export function Watches() {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    const response = await runCommand(WatchList.make());
    if (response.failure) setLoaded({ kind: 'failed', failure: response.failure });
    else if (response.result._tag === 'WatchListResult')
      setLoaded({ kind: 'ready', list: response.result });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loaded.kind === 'loading') return <p className="opt-gate opt-meta">Loading Watches…</p>;
  if (loaded.kind === 'failed') return <LoginGate failure={loaded.failure} />;
  return <Console list={loaded.list} refresh={refresh} />;
}

function Feed({
  list,
  current,
  watch,
  actionFailure,
  onGo,
  onRun,
}: {
  list: WatchListResult;
  current: View;
  watch: WatchSummary | undefined;
  actionFailure: WatchFailure | undefined;
  onGo: (view: View) => void;
  onRun: (command: WatchCommand) => Promise<WatchFailure | undefined>;
}) {
  return (
    <section className="opt-feed">
      <StorageNotice storage={list.storage} />
      {actionFailure && <FailureNotice failure={actionFailure} />}
      {current === 'attention' && (
        <AttentionView watches={list.watches} onOpen={id => onGo({ watchId: id })} />
      )}
      {current === 'inbox' && (
        <>
          <h1 className="opt-h1">All inbox</h1>
          <p className="opt-note">
            Everything your Watches collected. Entries stay 30 days from when they were found, but
            Instagram can remove media sooner.
          </p>
        </>
      )}
      {current === 'new' && (
        <>
          <h1 className="opt-h1">Add Watch</h1>
          <AddWatchFlow onRun={onRun} onOpen={id => onGo({ watchId: id })} />
        </>
      )}
      {watch && <WatchDetail watch={watch} />}
    </section>
  );
}

function Console({ list, refresh }: { list: WatchListResult; refresh: () => Promise<void> }) {
  const [view, setView] = useState<View>();
  const [actionFailure, setActionFailure] = useState<WatchFailure>();
  const attention = attentionTotal(list);
  const current = view ?? (attention > 0 ? 'attention' : 'inbox');
  const watch =
    typeof current === 'object'
      ? list.watches.find(candidate => candidate.watchId === current.watchId)
      : undefined;

  const go = (next: View) => {
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
    <div className="opt-console">
      <Navigation
        list={list}
        current={current}
        attention={attention}
        activeWatchId={watch?.watchId}
        onGo={go}
      />

      <Feed
        list={list}
        current={current}
        watch={watch}
        actionFailure={actionFailure}
        onGo={go}
        onRun={run}
      />

      <section className="opt-inspector">
        {watch ? (
          <WatchSettings watch={watch} onRun={run} onDeleted={() => go('inbox')} />
        ) : (
          <p className="opt-meta">Pick a Watch on the left to change it.</p>
        )}
      </section>
    </div>
  );
}
