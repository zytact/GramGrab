// PROTOTYPE, throwaway. Pieces shared by the variants. Layout stays per variant.
import { useState } from 'react';
import {
  ACTION_KINDS,
  DIRECTORY,
  MEDIA_KINDS,
  NOTIFICATION,
  actionLabel,
  actionNote,
  currentViewer,
  daysLeft,
  effectiveHealth,
  exportModesFor,
  hiddenWatchCount,
  kindLabel,
  kindNote,
  problemText,
  storageUsed,
  unavailableText,
  visibleWatches,
  type ActionKind,
  type Avatar,
  type Discovery,
  type Dispatch,
  type MediaKind,
  type Outcome,
  type State,
  type Watch,
} from './data';

export function AvatarImg({ avatar, size = 32 }: { avatar: Avatar; size?: number }) {
  if (avatar === 'failed')
    return (
      <span
        className="pt-avatar pt-avatar-fallback"
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        title="Avatar could not load"
      >
        G
      </span>
    );
  return (
    <span
      className="pt-avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(135deg, hsl(${avatar.hue} 65% 55%), hsl(${avatar.hue + 40} 70% 35%))`,
      }}
    >
      {avatar.initial}
    </span>
  );
}

// The account name with its Avatar. A verified rename shows the old name once.
export function AccountName({ watch, size = 32 }: { watch: Watch; size?: number }) {
  return (
    <span className="pt-account">
      <AvatarImg avatar={watch.avatar} size={size} />
      <span className="pt-account-text">
        <span>@{watch.username}</span>
        {watch.formerUsername && <span className="pt-meta">was @{watch.formerUsername}</span>}
      </span>
    </span>
  );
}

// Which Instagram login GramGrab verified. Watches belong to the login that created them.
export function ViewerChip({ state }: { state: State }) {
  const viewer = currentViewer(state);
  return viewer ? (
    <span className="pt-viewer" title="Verified from your Instagram session">
      <AvatarImg avatar={viewer.avatar} size={22} />
      <span>
        <span className="pt-meta">Instagram login</span> @{viewer.username}
      </span>
    </span>
  ) : (
    <span className="pt-viewer pt-text-error">
      <span className="pt-avatar pt-avatar-fallback" style={{ width: 22, height: 22 }}>
        ?
      </span>
      Instagram login not confirmed
    </span>
  );
}

// Full-page state when no login can be verified. Nothing owner-bound is shown.
export function LoginGate({ state }: { state: State }) {
  return (
    <div className="pt-gate">
      <h1 className="pt-h1">Sign in to Instagram</h1>
      <p className="pt-note">
        GramGrab could not confirm which Instagram account this browser is signed in to, so all
        Watch checks are paused. Your Watches, their inboxes, and any failures are kept and come
        back when the login that created them is signed in again.
      </p>
      <p className="pt-meta">{state.watches.length} Watches stored in this browser.</p>
      <a className="pt-btn pt-primary" href="#">
        Open instagram.com
      </a>
    </div>
  );
}

export function HiddenWatchesNotice({ state }: { state: State }) {
  const hidden = hiddenWatchCount(state);
  if (hidden === 0) return null;
  return (
    <p className="pt-banner">
      {hidden} {hidden === 1 ? 'Watch belongs' : 'Watches belong'} to another Instagram login.{' '}
      {hidden === 1 ? 'It is' : 'They are'} paused and hidden until that login signs in again.
    </p>
  );
}

export function StorageNotice({ state }: { state: State }) {
  const storage = state.scenario.storage;
  if (storage === 'ok') return null;
  const text = {
    full: 'Watch storage is full. Checks that found new media stopped and nothing was dropped. Remove inbox entries or delete a Watch to free space.',
    'write-failed':
      'The browser refused to save Watch data. Checks that needed to save stopped. Nothing was lost.',
    unreadable:
      'Saved Watch data could not be read. GramGrab did not reset anything and stopped all checks. Export diagnostics to report it.',
  }[storage];
  return (
    <div className="pt-banner pt-banner-error">
      <strong>Watches stopped.</strong> {text}
    </div>
  );
}

export function StorageMeter({ state }: { state: State }) {
  const used = storageUsed(state);
  return (
    <div className="pt-storage">
      <div className="pt-row pt-between pt-meta">
        <span>Watch storage</span>
        <span>
          {state.scenario.storage === 'unreadable' ? 'unreadable' : `${used.toFixed(2)} of 2 MiB`}
        </span>
      </div>
      <div className={`pt-bar ${state.scenario.storage === 'ok' ? '' : 'pt-bar-error'}`}>
        <div style={{ width: `${(used / 2) * 100}%` }} />
      </div>
    </div>
  );
}

export function KindHealthList({ state, watch }: { state: State; watch: Watch }) {
  return (
    <div className="pt-health">
      {MEDIA_KINDS.flatMap(kind => {
        const health = watch.kinds[kind];
        if (!health) return [];
        const h = effectiveHealth(state, health);
        const text =
          h.tag === 'baseline'
            ? 'First check pending. It records what is already there and acts on nothing.'
            : h.tag === 'ok'
              ? `Checked ${h.lastSuccess}`
              : h.tag === 'off'
                ? 'Off. Its baseline is kept, so turning it back on catches up on the last 30 days.'
                : `${problemText[h.problem]}${h.lastSuccess ? ` Last success ${h.lastSuccess}.` : ''}`;
        return [
          <div key={kind} className={`pt-health-row pt-health-${h.tag}`}>
            <strong>{kindLabel[kind]}</strong>
            <span>{watch.enabled || h.tag === 'off' ? text : 'Paused'}</span>
          </div>,
        ];
      })}
    </div>
  );
}

const outcomeText: Record<Outcome, string> = {
  done: 'done',
  failed: 'failed',
  uncertain: 'unconfirmed',
  pending: 'waiting',
};

const outcomeLabel: Record<ActionKind, string> = {
  notify: 'Notified',
  download: 'Downloaded',
  collect: 'Collected',
};

export function OutcomeChips({ discovery }: { discovery: Discovery }) {
  return (
    <span className="pt-chips">
      {ACTION_KINDS.flatMap(a => {
        const outcome = discovery.outcomes[a];
        return outcome
          ? [
              <span key={a} className={`pt-chip pt-${outcome}`}>
                {outcomeLabel[a]}: {outcomeText[outcome]}
              </span>,
            ]
          : [];
      })}
    </span>
  );
}

const retryLabel: Record<ActionKind, string> = {
  notify: 'Show notification again',
  download: 'Retry download',
  collect: 'Retry collecting',
};

// Recovery for failed or unconfirmed actions. Retries target this exact item only.
export function Recovery({ discovery, dispatch }: { discovery: Discovery; dispatch: Dispatch }) {
  const failed = ACTION_KINDS.filter(a => discovery.outcomes[a] === 'failed');
  const uncertain = discovery.outcomes.download === 'uncertain';
  if ((failed.length === 0 && !uncertain) || discovery.acknowledged) return null;
  const remaining = discovery.children?.filter(c => c.download === 'failed').length;
  return (
    <div className="pt-recovery">
      {discovery.note && <p className="pt-note">{discovery.note}</p>}
      <div className="pt-row">
        {failed.map(a => (
          <button
            key={a}
            className="pt-btn"
            onClick={() => dispatch({ type: 'retry', discoveryId: discovery.id, action: a })}
          >
            {retryLabel[a]}
            {a === 'download' && remaining ? ` (${remaining} left)` : ''}
          </button>
        ))}
        {uncertain && (
          <>
            <button
              className="pt-btn"
              onClick={() =>
                dispatch({ type: 'resolve-uncertain', discoveryId: discovery.id, downloaded: true })
              }
            >
              I have the file
            </button>
            <button
              className="pt-btn"
              onClick={() =>
                dispatch({
                  type: 'resolve-uncertain',
                  discoveryId: discovery.id,
                  downloaded: false,
                })
              }
            >
              Download again
            </button>
          </>
        )}
        <button
          className="pt-btn pt-ghost"
          onClick={() => dispatch({ type: 'acknowledge', discoveryId: discovery.id })}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function Thumb({ discovery, size = 56 }: { discovery: Discovery; size?: number }) {
  const gone = discovery.unavailable !== undefined;
  return (
    <div
      className={`pt-thumb ${gone ? 'pt-unavailable' : ''}`}
      style={{ width: size, height: size }}
    >
      {gone
        ? 'unavailable'
        : discovery.kind === 'avatar'
          ? '◉'
          : discovery.media === 'video'
            ? '▶'
            : discovery.media === 'sidecar'
              ? `▦ ${discovery.children?.length}`
              : '◩'}
    </div>
  );
}

export function EntryMeta({ discovery }: { discovery: Discovery }) {
  const missingChildren = discovery.children?.filter(c => c.unavailable).length ?? 0;
  return (
    <span className="pt-meta">
      {kindLabel[discovery.kind]} · found {discovery.checkedAt}
      {discovery.inInbox && ` · leaves the inbox in ${daysLeft(discovery)} days`}
      {discovery.unavailable && (
        <span className="pt-text-error"> · {unavailableText[discovery.unavailable]}</span>
      )}
      {missingChildren > 0 && (
        <span className="pt-text-error"> · {missingChildren} photo no longer available</span>
      )}
    </span>
  );
}

// Export controls for selected inbox entries. Downloads directly; no Workspace tab involved.
export function ExportControls({
  selected,
  dispatch,
  onDone,
  vertical,
}: {
  selected: ReadonlyArray<Discovery>;
  dispatch: Dispatch;
  onDone?: () => void;
  vertical?: boolean;
}) {
  const [mode, setMode] = useState('Original');
  const [rotated, setRotated] = useState(false);
  const [frameSecond, setFrameSecond] = useState(0);
  const exportable = selected.filter(d => d.unavailable === undefined);
  const modes =
    exportable.length > 0
      ? exportable.map(exportModesFor).reduce((a, b) => a.filter(m => b.includes(m)))
      : ['Original'];
  const chosen = modes.includes(mode) ? mode : 'Original';
  return (
    <div className={`pt-export ${vertical ? 'pt-export-vertical' : ''}`}>
      <label className="pt-field">
        Export mode
        <select value={chosen} onChange={e => setMode(e.target.value)}>
          {modes.map(m => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      {chosen === 'Frame' && (
        <label className="pt-field">
          at
          <input
            className="pt-seconds"
            type="number"
            min={0}
            value={frameSecond}
            onChange={e => setFrameSecond(Number(e.target.value))}
          />
          s
        </label>
      )}
      <label className="pt-check">
        <input type="checkbox" checked={rotated} onChange={e => setRotated(e.target.checked)} />
        Rotate 90°
      </label>
      <button
        className="pt-btn pt-primary"
        disabled={exportable.length === 0}
        onClick={() => {
          dispatch({
            type: 'export',
            discoveryIds: exportable.map(d => d.id),
            mode: chosen === 'Frame' ? `Frame at ${frameSecond}s` : chosen,
            rotated,
          });
          onDone?.();
        }}
      >
        Download {exportable.length}
      </button>
    </div>
  );
}

export function KindToggles({
  watch,
  onToggle,
}: {
  watch: Watch;
  onToggle: (k: MediaKind) => void;
}) {
  return (
    <div className="pt-option-list">
      {MEDIA_KINDS.map(k => {
        const h = watch.kinds[k];
        return (
          <label key={k} className="pt-option">
            <input
              type="checkbox"
              checked={h !== undefined && h.tag !== 'off'}
              onChange={() => onToggle(k)}
            />
            <span>
              {kindLabel[k]}
              <span className="pt-meta">{kindNote[k]}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function ActionToggles({
  actions,
  onToggle,
}: {
  actions: ReadonlyArray<ActionKind>;
  onToggle: (a: ActionKind) => void;
}) {
  return (
    <div className="pt-option-list">
      {ACTION_KINDS.map(a => (
        <label key={a} className="pt-option">
          <input type="checkbox" checked={actions.includes(a)} onChange={() => onToggle(a)} />
          <span>
            {actionLabel[a]}
            <span className="pt-meta">
              {a === 'collect' && !actions.includes('collect')
                ? 'Off. Existing inbox entries stay until they expire or you remove them.'
                : actionNote[a]}
            </span>
          </span>
        </label>
      ))}
      {actions.length === 0 && (
        <p className="pt-note">No actions. New media still shows in this Watch's details.</p>
      )}
    </div>
  );
}

// Two-step add: resolve the account first, then choose kinds and actions.
export function AddWatchFlow({
  state,
  dispatch,
  onDone,
  onOpenExisting,
}: {
  state: State;
  dispatch: Dispatch;
  onDone?: () => void;
  onOpenExisting: (watchId: string) => void;
}) {
  const [input, setInput] = useState('');
  const [resolved, setResolved] = useState<string | null>(null);
  const [kinds, setKinds] = useState<ReadonlyArray<MediaKind>>(['posts', 'stories']);
  const [actions, setActions] = useState<ReadonlyArray<ActionKind>>(['notify', 'collect']);
  const [ack, setAck] = useState(false);
  const toggle = <T,>(list: ReadonlyArray<T>, x: T) =>
    list.includes(x) ? list.filter(y => y !== x) : [...list, x];
  const username = input
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '');
  const entry = resolved ? DIRECTORY[resolved] : undefined;
  const existing = resolved
    ? visibleWatches(state).find(w => w.targetId === entry?.targetId)
    : undefined;

  if (!resolved || !entry)
    return (
      <form
        className="pt-add"
        onSubmit={e => {
          e.preventDefault();
          setResolved(username);
        }}
      >
        <input
          className="url-input"
          placeholder="@username or instagram.com profile URL"
          value={input}
          onChange={e => {
            setInput(e.target.value);
            setResolved(null);
          }}
        />
        {resolved && !entry && (
          <p className="pt-note pt-text-error">
            Instagram did not return an account for @{resolved}.
          </p>
        )}
        <p className="pt-meta">Try nasa (already watched), sonyalpha, or canonusa.</p>
        <button className="pt-btn pt-primary" disabled={!username}>
          Find account
        </button>
      </form>
    );

  if (existing)
    return (
      <div className="pt-add">
        <AccountName watch={existing} size={40} />
        <p className="pt-note">
          You already watch this account. Each account has one Watch per login.
        </p>
        <button className="pt-btn pt-primary" onClick={() => onOpenExisting(existing.id)}>
          Open its Watch
        </button>
      </div>
    );

  return (
    <form
      className="pt-add"
      onSubmit={e => {
        e.preventDefault();
        dispatch({ type: 'add', username: resolved, kinds, actions });
        onDone?.();
      }}
    >
      <div className="pt-row">
        <AvatarImg avatar={entry.avatar} size={40} />
        <div className="pt-account-text">
          <span>@{resolved}</span>
          <span className="pt-meta">
            Followed by account ID, so a rename keeps this Watch on the same account.
          </span>
        </div>
        <button type="button" className="pt-btn pt-ghost" onClick={() => setResolved(null)}>
          Change
        </button>
      </div>
      <span className="pt-label">Watch for</span>
      <div className="pt-option-list">
        {MEDIA_KINDS.map(k => (
          <label key={k} className="pt-option">
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={() => setKinds(toggle(kinds, k))}
            />
            <span>
              {kindLabel[k]}
              <span className="pt-meta">{kindNote[k]}</span>
            </span>
          </label>
        ))}
      </div>
      <span className="pt-label">When something new appears</span>
      <ActionToggles actions={actions} onToggle={a => setActions(toggle(actions, a))} />
      <p className="pt-note">
        The first check records what is already there and acts on nothing. Checks run only while
        your browser is open, with a catch-up check when it starts.
      </p>
      <label className="pt-option pt-disclosure">
        <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
        <span>
          Watches use your Instagram login (@{currentViewer(state)?.username}) in the background,
          without you asking each time. Instagram may treat unattended traffic as unusual and limit
          or flag your account.
          <span className="pt-meta">
            Placeholder wording until the privacy amendment is decided.
          </span>
        </span>
      </label>
      <button className="pt-btn pt-primary" disabled={kinds.length === 0 || !ack}>
        Add Watch
      </button>
    </form>
  );
}

export function DeleteConfirm({
  watch,
  onConfirm,
  onCancel,
}: {
  watch: Watch;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pt-banner pt-banner-error">
      Delete the Watch for @{watch.username}? Its settings, seen media, Watch inbox, and pending
      actions go away. Downloaded files and History stay. Adding it again starts a fresh baseline.
      <div className="pt-row">
        <button className="pt-btn pt-danger" onClick={onConfirm}>
          Delete Watch
        </button>
        <button className="pt-btn pt-ghost" onClick={onCancel}>
          Keep
        </button>
      </div>
    </div>
  );
}

// Mock of the OS notification that deep-links to the Watch details.
export function NotificationMock({ watch }: { watch: Watch | undefined }) {
  if (!watch) return null;
  return (
    <div className="pt-notification">
      <AvatarImg avatar={watch.avatar} size={36} />
      <div>
        <strong>{NOTIFICATION.title}</strong>
        <div>{NOTIFICATION.body}</div>
        <span className="pt-meta">GramGrab · clicked, opened this Watch</span>
      </div>
    </div>
  );
}

// Toolbar icon with the persistent failure badge.
export function ToolbarIcon({ count }: { count: number }) {
  return (
    <span className="pt-toolbar-icon">
      G{count > 0 && <span className="pt-badge">{count}</span>}
    </span>
  );
}
