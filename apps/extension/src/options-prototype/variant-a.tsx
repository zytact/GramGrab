// PROTOTYPE, throwaway. Variant A: classic settings page. Sidebar sections, a Watch table,
// a full-page Watch details view, and one Watch inbox across every Watch.
import { useEffect, useState } from 'react';
import {
  MEDIA_KINDS,
  NOTIFIED_WATCH_ID,
  actionLabel,
  attentionCount,
  currentViewer,
  inboxEntries,
  kindLabel,
  kindProblems,
  openFailures,
  visibleWatches,
  watchDiscoveries,
  type State,
  type VariantProps,
  type Watch,
} from './data';
import {
  AccountName,
  ActionToggles,
  AddWatchFlow,
  AvatarImg,
  DeleteConfirm,
  EntryMeta,
  ExportControls,
  HiddenWatchesNotice,
  KindHealthList,
  KindToggles,
  LoginGate,
  NotificationMock,
  OutcomeChips,
  Recovery,
  StorageMeter,
  StorageNotice,
  Thumb,
  ToolbarIcon,
  ViewerChip,
} from './parts';

export const name = 'Settings sidebar';

type Section = 'watches' | 'inbox' | 'add';

export function VariantA({ state, dispatch }: VariantProps) {
  const [section, setSection] = useState<Section>('watches');
  const [openWatch, setOpenWatch] = useState<string | null>(null);

  useEffect(() => {
    if (state.scenario.fromNotification) {
      setSection('watches');
      setOpenWatch(NOTIFIED_WATCH_ID);
    }
  }, [state.scenario.fromNotification]);

  const watches = visibleWatches(state);
  const watch = watches.find(w => w.id === openWatch);
  const attention = attentionCount(state);
  const verified = currentViewer(state) !== null;

  return (
    <div className="pt-a">
      <PopupEntry attention={attention} />
      <aside className="pt-a-nav">
        <div className="ext-logo">
          Gram<em>Grab</em>
        </div>
        <span className="pt-label">Options</span>
        {verified &&
          (
            [
              ['watches', `Watches${attention ? ` · ${attention} need you` : ''}`],
              ['inbox', `Watch inbox (${inboxEntries(state).length})`],
              ['add', '+ Add Watch'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={section === key && !watch ? 'active' : ''}
              onClick={() => {
                setSection(key);
                setOpenWatch(null);
              }}
            >
              {label}
            </button>
          ))}
        <div className="pt-a-nav-foot">
          <ViewerChip state={state} />
          <StorageMeter state={state} />
        </div>
      </aside>

      <main className="pt-a-main">
        {!verified ? (
          <LoginGate state={state} />
        ) : (
          <>
            <StorageNotice state={state} />
            {section === 'watches' && !watch && (
              <>
                <h1 className="pt-h1">Watches</h1>
                <HiddenWatchesNotice state={state} />
                <WatchTable state={state} watches={watches} onOpen={setOpenWatch} />
              </>
            )}
            {section === 'watches' && watch && (
              <WatchDetails {...{ state, dispatch, watch }} onBack={() => setOpenWatch(null)} />
            )}
            {section === 'inbox' && <SharedInbox state={state} dispatch={dispatch} />}
            {section === 'add' && (
              <>
                <h1 className="pt-h1">Add Watch</h1>
                <AddWatchFlow
                  state={state}
                  dispatch={dispatch}
                  onDone={() => setSection('watches')}
                  onOpenExisting={id => {
                    setSection('watches');
                    setOpenWatch(id);
                  }}
                />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function WatchTable({
  state,
  watches,
  onOpen,
}: {
  state: State;
  watches: ReadonlyArray<Watch>;
  onOpen: (id: string) => void;
}) {
  return (
    <table className="pt-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Watching</th>
          <th>Actions</th>
          <th>Last check</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {watches.map(w => (
          <tr key={w.id} onClick={() => onOpen(w.id)}>
            <td>
              <AccountName watch={w} />
            </td>
            <td>
              {MEDIA_KINDS.filter(k => w.kinds[k] && w.kinds[k]?.tag !== 'off')
                .map(k => kindLabel[k])
                .join(', ')}
            </td>
            <td>{w.actions.map(a => actionLabel[a]).join(', ') || 'None'}</td>
            <td>{w.lastCheck}</td>
            <td>
              <StatusCell state={state} watch={w} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusCell({ state, watch }: { state: State; watch: Watch }) {
  if (!watch.enabled) return <span className="pt-chip">Paused</span>;
  const failures = openFailures(state, watch.id).length;
  const problems = kindProblems(state, watch).length;
  return (
    <span className="pt-chips">
      {failures > 0 && (
        <span className="pt-chip pt-failed">
          {failures} {failures === 1 ? 'action needs' : 'actions need'} you
        </span>
      )}
      {problems > 0 && (
        <span className="pt-chip pt-failed">
          {problems} check {problems === 1 ? 'problem' : 'problems'}
        </span>
      )}
      {MEDIA_KINDS.some(k => watch.kinds[k]?.tag === 'baseline') && (
        <span className="pt-chip">Baseline pending</span>
      )}
      {failures + problems === 0 && !MEDIA_KINDS.some(k => watch.kinds[k]?.tag === 'baseline') && (
        <span className="pt-chip pt-done">OK</span>
      )}
    </span>
  );
}

function WatchDetails({
  state,
  dispatch,
  watch,
  onBack,
}: VariantProps & { watch: Watch; onBack: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const discoveries = watchDiscoveries(state, watch.id);
  return (
    <div className="pt-details">
      <button className="pt-btn pt-ghost" onClick={onBack}>
        ← Watches
      </button>
      {state.scenario.fromNotification && watch.id === NOTIFIED_WATCH_ID && (
        <NotificationMock watch={watch} />
      )}
      <div className="pt-row pt-between">
        <AccountName watch={watch} size={56} />
        <div className="pt-row">
          <button
            className="pt-btn"
            onClick={() => dispatch({ type: 'toggle-enabled', watchId: watch.id })}
          >
            {watch.enabled ? 'Pause' : 'Resume'}
          </button>
          <button className="pt-btn pt-danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        </div>
      </div>
      {!watch.enabled && (
        <p className="pt-banner">
          Paused. Its inbox and baselines are kept; resuming catches up on the last 30 days.
        </p>
      )}
      {confirmDelete && (
        <DeleteConfirm
          watch={watch}
          onConfirm={() => {
            dispatch({ type: 'delete', watchId: watch.id });
            onBack();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <h2 className="pt-h2">Checks</h2>
      <KindHealthList state={state} watch={watch} />

      <section className="pt-grid2">
        <div>
          <span className="pt-label">Watch for</span>
          <KindToggles
            watch={watch}
            onToggle={kind => dispatch({ type: 'toggle-kind', watchId: watch.id, kind })}
          />
        </div>
        <div>
          <span className="pt-label">When something new appears</span>
          <ActionToggles
            actions={watch.actions}
            onToggle={action => dispatch({ type: 'toggle-action', watchId: watch.id, action })}
          />
        </div>
      </section>

      <h2 className="pt-h2">Found</h2>
      {discoveries.length === 0 && <p className="pt-meta">Nothing new since the baseline.</p>}
      {discoveries.map(d => (
        <div key={d.id} className="pt-line pt-row pt-top">
          <Thumb discovery={d} />
          <div className="pt-grow">
            <div>{d.label}</div>
            <EntryMeta discovery={d} />
            <OutcomeChips discovery={d} />
            <Recovery discovery={d} dispatch={dispatch} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SharedInbox({ state, dispatch }: VariantProps) {
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const watches = visibleWatches(state);
  const entries = inboxEntries(state).filter(d => filter === 'all' || d.watchId === filter);
  const owner = (id: string) => watches.find(w => w.id === id);
  return (
    <>
      <div className="pt-row pt-between">
        <h1 className="pt-h1">Watch inbox</h1>
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">All Watches</option>
          {watches.map(w => (
            <option key={w.id} value={w.id}>
              @{w.username}
            </option>
          ))}
        </select>
      </div>
      <p className="pt-note">
        Entries stay 30 days from when they were found. Media can disappear from Instagram sooner.
      </p>
      <ExportControls
        selected={entries.filter(d => selected.includes(d.id))}
        dispatch={dispatch}
        onDone={() => setSelected([])}
      />
      {entries.length === 0 && <p className="pt-meta">Nothing collected.</p>}
      {entries.map(d => {
        const w = owner(d.watchId);
        return (
          <div key={d.id} className="pt-line pt-row">
            <input
              type="checkbox"
              disabled={d.unavailable !== undefined}
              checked={selected.includes(d.id)}
              onChange={() =>
                setSelected(s => (s.includes(d.id) ? s.filter(x => x !== d.id) : [...s, d.id]))
              }
            />
            <Thumb discovery={d} />
            <div className="pt-grow">
              <div className="pt-row">
                {w && <AvatarImg avatar={w.avatar} size={18} />}@{w?.username} · {d.label}
              </div>
              <EntryMeta discovery={d} />
            </div>
            <button
              className="pt-btn pt-ghost"
              onClick={() => dispatch({ type: 'remove-entry', discoveryId: d.id })}
            >
              Remove
            </button>
          </div>
        );
      })}
    </>
  );
}

function PopupEntry({ attention }: { attention: number }) {
  return (
    <div className="pt-popup-preview">
      <span className="pt-label">Popup entry (footer link)</span>
      <div className="pt-row">
        <ToolbarIcon count={attention} />
        <div className="ext-footer pt-popup-footer">
          <span className="footer-brand">GramGrab</span>
          <a href="#">⚙ Watches{attention ? ` · ${attention} need you` : ''}</a>
        </div>
      </div>
    </div>
  );
}
