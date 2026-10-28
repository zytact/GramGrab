// PROTOTYPE for issue #344. Dev-only page: `vp run prototype:sidebar`. Not a build input, so it never ships.
import '../options.css';
import './sidebar-prototype.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { makeNames, makeWatches, nextChecks, STORAGE, type LinkState, type View } from './data.ts';
import { VARIANTS, type VariantKey } from './variants.tsx';

const KEYS = Object.keys(VARIANTS) as VariantKey[];

const VIEW_TITLE = {
  attention: 'Needs you',
  inbox: 'All inbox',
  new: 'Add Watch',
  transfer: 'Export or import',
} as const;

const initialVariant = (): VariantKey =>
  KEYS.find(key => key === new URLSearchParams(location.search).get('variant')) ?? 'A';

function Prototype() {
  const [variant, setVariant] = useState(initialVariant);
  const [linkState, setLinkState] = useState<LinkState>('linked');
  const [count, setCount] = useState(31);
  const [longNames, setLongNames] = useState(true);
  const [view, setView] = useState<View>('inbox');

  const go = (offset: number) => {
    const next = KEYS[(KEYS.indexOf(variant) + offset + KEYS.length) % KEYS.length] ?? 'A';
    setVariant(next);
    const url = new URL(location.href);
    url.searchParams.set('variant', next);
    history.replaceState(null, '', url);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable]')
      )
        return;
      if (event.key === 'ArrowLeft') go(-1);
      if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const watches = makeWatches(count, linkState);
  const selected =
    typeof view === 'object' ? watches.find(item => item.watchId === view.watchId) : undefined;
  const state = {
    variant,
    linkState,
    watches: watches.length,
    view: selected
      ? { username: selected.username, owner: selected.owner, held: selected.held }
      : view,
  };
  const { Component } = VARIANTS[variant];

  return (
    <>
      <Component
        linkState={linkState}
        names={makeNames(longNames)}
        watches={watches}
        nextCheckAt={nextChecks(linkState)}
        storage={STORAGE}
        view={view}
        onGo={setView}
        onLink={() => setLinkState('linked')}
        onUnlink={() => setLinkState('unlinked')}
        feed={
          <section className="opt-feed">
            <h1 className="opt-h1">
              {selected ? `@${selected.username}` : typeof view === 'string' && VIEW_TITLE[view]}
            </h1>
            <p className="opt-note">
              Feed stub. The question is the sidebar, so this pane only echoes state.
            </p>
            <pre className="pv-state">{JSON.stringify(state, null, 2)}</pre>
          </section>
        }
        inspector={
          <section className="opt-inspector">
            <p className="opt-meta">Inspector stub.</p>
          </section>
        }
      />
      <div className="pv-switcher-bar">
        <button onClick={() => go(-1)} title="Previous variant (←)">
          ←
        </button>
        <span>
          {variant} ({VARIANTS[variant].name})
        </span>
        <button onClick={() => go(1)} title="Next variant (→)">
          →
        </button>
        <span className="pv-bar-rule" />
        <select
          value={linkState}
          onChange={event => {
            const next = event.target.value;
            if (next === 'linked' || next === 'ended' || next === 'unlinked') setLinkState(next);
          }}
        >
          <option value="linked">Linked</option>
          <option value="ended">Linked, signed out</option>
          <option value="unlinked">Unlinked</option>
        </select>
        <select value={count} onChange={event => setCount(Number(event.target.value))}>
          <option value={3}>3 main Watches</option>
          <option value={31}>31 main Watches</option>
          <option value={80}>80 main Watches</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={longNames}
            onChange={event => setLongNames(event.target.checked)}
          />{' '}
          Long names
        </label>
      </div>
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Prototype />);
