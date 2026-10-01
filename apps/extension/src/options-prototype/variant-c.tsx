// PROTOTYPE, throwaway. Variant C: attention-first single column. A "Needs you" queue gathers
// every problem with its fix, a thumbnail inbox strip comes next, and Watches sit at the bottom
// as Avatar cards edited in place.
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
  problemText,
  visibleWatches,
  watchDiscoveries,
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

export const name = 'Attention first';

export function VariantC({ state, dispatch }: VariantProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    if (state.scenario.fromNotification) setExpanded(NOTIFIED_WATCH_ID);
  }, [state.scenario.fromNotification]);

  const watches = visibleWatches(state);
  const byId = (id: string) => watches.find(w => w.id === id);
  const failures = openFailures(state);
  const problems = watches.flatMap(w => kindProblems(state, w).map(p => ({ watch: w, ...p })));
  const attention = attentionCount(state);
  const inbox = inboxEntries(state);
  const verified = currentViewer(state) !== null;

  return (
    <div className="pt-c">
      <PopupEntry attention={attention} />
      <header className="pt-row pt-between pt-c-head">
        <div className="ext-logo">
          Gram<em>Grab</em> <span className="pt-meta">Watches</span>
        </div>
        <div className="pt-row">
          <ViewerChip state={state} />
          {verified && (
            <button className="pt-btn pt-primary" onClick={() => setAdding(a => !a)}>
              {adding ? 'Cancel' : '+ Add Watch'}
            </button>
          )}
        </div>
      </header>

      {!verified ? (
        <LoginGate state={state} />
      ) : (
        <>
          {adding && (
            <AddWatchFlow
              state={state}
              dispatch={dispatch}
              onDone={() => setAdding(false)}
              onOpenExisting={id => {
                setAdding(false);
                setExpanded(id);
              }}
            />
          )}
          {state.scenario.fromNotification && <NotificationMock watch={byId(NOTIFIED_WATCH_ID)} />}

          <section>
            <h2 className="pt-h2">Needs you {attention ? `(${attention})` : ''}</h2>
            {attention === 0 && <p className="pt-meta">Nothing needs attention.</p>}
            <StorageNotice state={state} />
            {problems.map(p => (
              <div key={p.watch.id + p.kind} className="pt-line pt-row pt-top">
                <AvatarImg avatar={p.watch.avatar} size={32} />
                <div className="pt-grow">
                  <strong>
                    @{p.watch.username} · {kindLabel[p.kind]} check
                  </strong>
                  <span className="pt-meta">{problemText[p.problem]}</span>
                </div>
              </div>
            ))}
            {failures.map(d => {
              const w = byId(d.watchId);
              return (
                <div key={d.id} className="pt-line pt-row pt-top">
                  {w && <AvatarImg avatar={w.avatar} size={32} />}
                  <Thumb discovery={d} size={40} />
                  <div className="pt-grow">
                    <strong>
                      @{w?.username} · {d.label}
                    </strong>
                    <OutcomeChips discovery={d} />
                    <Recovery discovery={d} dispatch={dispatch} />
                  </div>
                </div>
              );
            })}
          </section>

          <section>
            <div className="pt-row pt-between">
              <h2 className="pt-h2">Watch inbox ({inbox.length})</h2>
              {selected.length > 0 && (
                <ExportControls
                  selected={inbox.filter(d => selected.includes(d.id))}
                  dispatch={dispatch}
                  onDone={() => setSelected([])}
                />
              )}
            </div>
            <p className="pt-meta">
              Tap to select. Entries stay 30 days from when they were found.
            </p>
            <div className="pt-c-strip">
              {inbox.map(d => {
                const w = byId(d.watchId);
                return (
                  <figure
                    key={d.id}
                    className={`pt-c-tile ${selected.includes(d.id) ? 'pt-selected' : ''}`}
                    onClick={() =>
                      d.unavailable === undefined &&
                      setSelected(s =>
                        s.includes(d.id) ? s.filter(x => x !== d.id) : [...s, d.id]
                      )
                    }
                  >
                    <Thumb discovery={d} size={120} />
                    <figcaption>
                      <span className="pt-row">
                        {w && <AvatarImg avatar={w.avatar} size={16} />}@{w?.username}
                      </span>
                      <EntryMeta discovery={d} />
                      <button
                        className="pt-btn pt-ghost"
                        onClick={e => {
                          e.stopPropagation();
                          dispatch({ type: 'remove-entry', discoveryId: d.id });
                        }}
                      >
                        Remove
                      </button>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="pt-h2">Watching</h2>
            <HiddenWatchesNotice state={state} />
            {watches.map(w => (
              <WatchCard
                key={w.id}
                {...{ state, dispatch }}
                watch={w}
                open={expanded === w.id}
                onToggle={() => setExpanded(e => (e === w.id ? null : w.id))}
              />
            ))}
            <StorageMeter state={state} />
          </section>
        </>
      )}
    </div>
  );
}

function WatchCard({
  state,
  dispatch,
  watch,
  open,
  onToggle,
}: VariantProps & { watch: Watch; open: boolean; onToggle: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const kinds = MEDIA_KINDS.filter(k => watch.kinds[k] && watch.kinds[k]?.tag !== 'off');
  const discoveries = watchDiscoveries(state, watch.id);
  return (
    <div className={`pt-card ${open ? 'pt-card-open' : ''} ${watch.enabled ? '' : 'pt-dim'}`}>
      <button className="pt-card-head" onClick={onToggle}>
        <AccountName watch={watch} />
        <span className="pt-meta">
          {kinds.map(k => kindLabel[k]).join(' · ')} →{' '}
          {watch.actions.map(a => actionLabel[a]).join(' + ') || 'no actions'}
        </span>
        <span className="pt-meta">{watch.enabled ? `checked ${watch.lastCheck}` : 'paused'}</span>
      </button>
      {open && (
        <div className="pt-card-body">
          <KindHealthList state={state} watch={watch} />
          <div className="pt-grid2">
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
          </div>
          <span className="pt-label">Found</span>
          {discoveries.length === 0 && <p className="pt-meta">Nothing new since the baseline.</p>}
          {discoveries.map(d => (
            <div key={d.id} className="pt-line pt-row pt-top">
              <Thumb discovery={d} size={40} />
              <div className="pt-grow">
                {d.label} <EntryMeta discovery={d} />
                <OutcomeChips discovery={d} />
              </div>
            </div>
          ))}
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
          {confirmDelete && (
            <DeleteConfirm
              watch={watch}
              onConfirm={() => dispatch({ type: 'delete', watchId: watch.id })}
              onCancel={() => setConfirmDelete(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

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
