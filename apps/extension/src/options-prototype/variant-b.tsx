// PROTOTYPE, throwaway. Variant B, the chosen layout: three-pane console. The left list holds
// "Needs you", "All inbox", and one Avatar row per Watch. The middle pane shows the selection.
// The right pane edits the Watch, or downloads the selected inbox items.
import { useEffect, useState } from 'react';
import {
  NOTIFIED_WATCH_ID,
  attentionCount,
  currentViewer,
  inboxEntries,
  kindLabel,
  kindProblems,
  openFailures,
  problemText,
  visibleWatches,
  watchDiscoveries,
  type Discovery,
  type Dispatch,
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

export const name = 'Three-pane console (chosen)';

type View = 'attention' | 'inbox' | 'new' | { watchId: string };

export function VariantB({ state, dispatch }: VariantProps) {
  const watches = visibleWatches(state);
  const attention = attentionCount(state);
  const [view, setView] = useState<View>(attention > 0 ? 'attention' : 'inbox');
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [tab, setTab] = useState<'found' | 'inbox'>('found');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const go = (next: View) => {
    setView(next);
    setSelected([]);
    setConfirmDelete(false);
    setTab('found');
  };

  useEffect(() => {
    if (state.scenario.fromNotification) go({ watchId: NOTIFIED_WATCH_ID });
  }, [state.scenario.fromNotification]);

  if (!currentViewer(state))
    return (
      <div className="pt-b-gate">
        <PopupEntry attention={0} />
        <LoginGate state={state} />
      </div>
    );

  const watch = typeof view === 'object' ? watches.find(w => w.id === view.watchId) : undefined;
  const allInbox = inboxEntries(state);
  const watchInbox = watch ? allInbox.filter(d => d.watchId === watch.id) : [];
  const selectable = view === 'inbox' ? allInbox : watchInbox;
  const selectedItems = selectable.filter(d => selected.includes(d.id));
  const toggleSelected = (id: string) =>
    setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]));

  return (
    <div className="pt-b">
      <PopupEntry attention={attention} />
      <nav className="pt-b-list">
        <div className="pt-b-head">
          <div className="ext-logo">
            Gram<em>Grab</em>
          </div>
          <ViewerChip state={state} />
        </div>
        <button
          className={`pt-b-item ${view === 'attention' ? 'active' : ''}`}
          onClick={() => go('attention')}
        >
          <span className="pt-b-icon">!</span>
          <span className="pt-grow">Needs you</span>
          {attention > 0 && <span className="pt-count pt-count-error">{attention}</span>}
        </button>
        <button
          className={`pt-b-item ${view === 'inbox' ? 'active' : ''}`}
          onClick={() => go('inbox')}
        >
          <span className="pt-b-icon">▤</span>
          <span className="pt-grow">All inbox</span>
          <span className="pt-count">{allInbox.length}</span>
        </button>
        <span className="pt-label pt-b-section">Watches ({watches.length})</span>
        {watches.map(w => {
          const bad = openFailures(state, w.id).length + kindProblems(state, w).length;
          return (
            <button
              key={w.id}
              className={`pt-b-item ${w.id === watch?.id ? 'active' : ''} ${w.enabled ? '' : 'pt-dim'}`}
              onClick={() => go({ watchId: w.id })}
            >
              <AvatarImg avatar={w.avatar} size={30} />
              <span className="pt-account-text pt-grow">
                <span>@{w.username}</span>
                <span className="pt-meta">
                  {!w.enabled ? 'Paused' : bad ? `${bad} need you` : `Checked ${w.lastCheck}`}
                </span>
              </span>
              {bad > 0 && w.enabled && <span className="pt-dot" />}
            </button>
          );
        })}
        <button
          className={`pt-b-item pt-b-add ${view === 'new' ? 'active' : ''}`}
          onClick={() => go('new')}
        >
          + Add Watch
        </button>
        <div className="pt-b-list-foot">
          <HiddenWatchesNotice state={state} />
          <StorageMeter state={state} />
        </div>
      </nav>

      <main className="pt-b-feed">
        <StorageNotice state={state} />
        {view === 'attention' && (
          <AttentionView state={state} dispatch={dispatch} onOpen={id => go({ watchId: id })} />
        )}
        {view === 'inbox' && (
          <>
            <h1 className="pt-h1">All inbox</h1>
            <p className="pt-note">
              Everything your Watches collected. Entries stay 30 days from when they were found, but
              Instagram can remove media sooner.
            </p>
            <InboxList
              entries={allInbox}
              watches={watches}
              selected={selected}
              onToggle={toggleSelected}
              dispatch={dispatch}
            />
          </>
        )}
        {view === 'new' && (
          <>
            <h1 className="pt-h1">Add Watch</h1>
            <AddWatchFlow
              state={state}
              dispatch={dispatch}
              onDone={() => go('inbox')}
              onOpenExisting={id => go({ watchId: id })}
            />
          </>
        )}
        {watch && (
          <>
            {state.scenario.fromNotification && watch.id === NOTIFIED_WATCH_ID && (
              <NotificationMock watch={watch} />
            )}
            <div className="pt-row pt-between">
              <AccountName watch={watch} size={48} />
              <div className="pt-tabs">
                <button className={tab === 'found' ? 'active' : ''} onClick={() => setTab('found')}>
                  Found ({watchDiscoveries(state, watch.id).length})
                </button>
                <button className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}>
                  Inbox ({watchInbox.length})
                </button>
              </div>
            </div>
            {!watch.enabled && (
              <p className="pt-banner">
                Paused. The inbox and baselines are kept. Resuming catches up on the last 30 days.
              </p>
            )}
            <KindHealthList state={state} watch={watch} />
            {tab === 'found' ? (
              <FoundList discoveries={watchDiscoveries(state, watch.id)} dispatch={dispatch} />
            ) : (
              <InboxList
                entries={watchInbox}
                watches={watches}
                selected={selected}
                onToggle={toggleSelected}
                dispatch={dispatch}
              />
            )}
          </>
        )}
      </main>

      <aside className="pt-b-inspector">
        {selectedItems.length > 0 ? (
          <>
            <span className="pt-label">Download {selectedItems.length} selected</span>
            <ExportControls
              vertical
              selected={selectedItems}
              dispatch={dispatch}
              onDone={() => setSelected([])}
            />
            <button className="pt-btn pt-ghost" onClick={() => setSelected([])}>
              Clear selection
            </button>
          </>
        ) : watch ? (
          <WatchSettings
            watch={watch}
            dispatch={dispatch}
            confirmDelete={confirmDelete}
            setConfirmDelete={setConfirmDelete}
            onDeleted={() => go('inbox')}
          />
        ) : (
          <p className="pt-meta">
            {view === 'inbox'
              ? 'Select inbox items to choose how to download them.'
              : 'Pick a Watch on the left to change it.'}
          </p>
        )}
      </aside>
    </div>
  );
}

// Every problem across the verified login's Watches, each with its fix.
function AttentionView({
  state,
  dispatch,
  onOpen,
}: {
  state: State;
  dispatch: Dispatch;
  onOpen: (watchId: string) => void;
}) {
  const watches = visibleWatches(state);
  const byId = (id: string) => watches.find(w => w.id === id);
  const problems = watches.flatMap(w => kindProblems(state, w).map(p => ({ watch: w, ...p })));
  const failures = openFailures(state);
  return (
    <>
      <h1 className="pt-h1">Needs you</h1>
      {problems.length + failures.length === 0 && state.scenario.storage === 'ok' && (
        <p className="pt-note">All clear. Nothing needs you right now.</p>
      )}
      {problems.length > 0 && <h2 className="pt-h2">Checks that could not run</h2>}
      {problems.map(p => (
        <div key={p.watch.id + p.kind} className="pt-line pt-row pt-top">
          <AvatarImg avatar={p.watch.avatar} size={32} />
          <div className="pt-grow">
            <strong>
              @{p.watch.username} · {kindLabel[p.kind]}
            </strong>
            <span className="pt-meta">{problemText[p.problem]}</span>
          </div>
          <button className="pt-btn pt-ghost" onClick={() => onOpen(p.watch.id)}>
            Open Watch
          </button>
        </div>
      ))}
      {failures.length > 0 && <h2 className="pt-h2">Actions that did not finish</h2>}
      {failures.map(d => {
        const w = byId(d.watchId);
        return (
          <div key={d.id} className="pt-line pt-row pt-top">
            {w && <AvatarImg avatar={w.avatar} size={32} />}
            <Thumb discovery={d} size={44} />
            <div className="pt-grow">
              <strong>
                @{w?.username} · {d.label}
              </strong>
              <OutcomeChips discovery={d} />
              <Recovery discovery={d} dispatch={dispatch} />
            </div>
            <button className="pt-btn pt-ghost" onClick={() => onOpen(d.watchId)}>
              Open Watch
            </button>
          </div>
        );
      })}
    </>
  );
}

function FoundList({
  discoveries,
  dispatch,
}: {
  discoveries: ReadonlyArray<Discovery>;
  dispatch: Dispatch;
}) {
  if (discoveries.length === 0) return <p className="pt-meta">Nothing new since the baseline.</p>;
  return (
    <>
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
    </>
  );
}

function InboxList({
  entries,
  watches,
  selected,
  onToggle,
  dispatch,
}: {
  entries: ReadonlyArray<Discovery>;
  watches: ReadonlyArray<Watch>;
  selected: ReadonlyArray<string>;
  onToggle: (id: string) => void;
  dispatch: Dispatch;
}) {
  if (entries.length === 0) return <p className="pt-meta">Nothing collected.</p>;
  return (
    <>
      {entries.map(d => {
        const w = watches.find(x => x.id === d.watchId);
        const gone = d.unavailable !== undefined;
        return (
          <label
            key={d.id}
            className={`pt-line pt-row ${selected.includes(d.id) ? 'pt-selected' : ''} ${
              gone ? '' : 'pt-clickable'
            }`}
          >
            <input
              type="checkbox"
              disabled={gone}
              checked={selected.includes(d.id)}
              onChange={() => onToggle(d.id)}
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
              onClick={e => {
                e.preventDefault();
                dispatch({ type: 'remove-entry', discoveryId: d.id });
              }}
            >
              Remove
            </button>
          </label>
        );
      })}
    </>
  );
}

function WatchSettings({
  watch,
  dispatch,
  confirmDelete,
  setConfirmDelete,
  onDeleted,
}: {
  watch: Watch;
  dispatch: Dispatch;
  confirmDelete: boolean;
  setConfirmDelete: (open: boolean) => void;
  onDeleted: () => void;
}) {
  return (
    <>
      <span className="pt-label">Watch for</span>
      <KindToggles
        watch={watch}
        onToggle={kind => dispatch({ type: 'toggle-kind', watchId: watch.id, kind })}
      />
      <span className="pt-label">When something new appears</span>
      <ActionToggles
        actions={watch.actions}
        onToggle={action => dispatch({ type: 'toggle-action', watchId: watch.id, action })}
      />
      <span className="pt-label">Watch</span>
      <div className="pt-col">
        <button
          className="pt-btn"
          onClick={() => dispatch({ type: 'toggle-enabled', watchId: watch.id })}
        >
          {watch.enabled ? 'Pause checks' : 'Resume checks'}
        </button>
        <button className="pt-btn pt-danger" onClick={() => setConfirmDelete(true)}>
          Delete Watch
        </button>
        {confirmDelete && (
          <DeleteConfirm
            watch={watch}
            onConfirm={() => {
              dispatch({ type: 'delete', watchId: watch.id });
              onDeleted();
            }}
            onCancel={() => setConfirmDelete(false)}
          />
        )}
      </div>
    </>
  );
}

// Popup header button next to Workspace, showing how many things need attention.
function PopupEntry({ attention }: { attention: number }) {
  return (
    <div className="pt-popup-preview">
      <span className="pt-label">Popup entry (header button)</span>
      <div className="pt-row">
        <ToolbarIcon count={attention} />
        <div className="ext-header pt-popup-header">
          <div className="ext-logo">
            Gram<em>Grab</em>
          </div>
          <div className="ext-meta">
            <button className="workspace-launch">Workspace</button>
            <button className={`workspace-launch ${attention ? 'pt-text-error' : ''}`}>
              Watches{attention ? ` · ${attention}` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
