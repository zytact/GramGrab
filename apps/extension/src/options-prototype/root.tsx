// PROTOTYPE, throwaway. Options page prototype for issue 189. Three variants of the options
// page, switchable via ?variant=A|B|C on templates/options-prototype.html. Mock data only.
// Run with `vp run prototype:options`.
import { useEffect, useState } from 'react';
import { usePrototypeState, type Login, type Scenario, type Storage } from './data';
import { VariantA, name as nameA } from './variant-a';
import { VariantB, name as nameB } from './variant-b';
import { VariantC, name as nameC } from './variant-c';

const variants = [
  { key: 'A', name: nameA, View: VariantA },
  { key: 'B', name: nameB, View: VariantB },
  { key: 'C', name: nameC, View: VariantC },
] as const;

const readVariant = () => {
  const key = new URLSearchParams(window.location.search).get('variant');
  const index = variants.findIndex(v => v.key === key);
  return index === -1 ? 1 : index;
};

export function PrototypeRoot() {
  const [state, dispatch] = usePrototypeState();
  const [index, setIndex] = useState(readVariant);
  const [showState, setShowState] = useState(false);

  const go = (delta: number) =>
    setIndex(i => {
      const next = (i + delta + variants.length) % variants.length;
      const url = new URL(window.location.href);
      url.searchParams.set('variant', variants[next]!.key);
      window.history.replaceState(null, '', url);
      return next;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { key, name, View } = variants[index]!;
  const scenario = (patch: Partial<Scenario>) => dispatch({ type: 'scenario', patch });

  return (
    <>
      <View key={key} state={state} dispatch={dispatch} />
      <div className="pt-switcher">
        <button onClick={() => go(-1)}>←</button>
        <span>
          {key} ({name})
        </span>
        <button onClick={() => go(1)}>→</button>
        <span className="pt-sep" />
        <label>
          <input
            type="checkbox"
            checked={state.scenario.fromNotification}
            onChange={e => scenario({ fromNotification: e.target.checked })}
          />
          from notification
        </label>
        <select
          value={state.scenario.storage}
          onChange={e => scenario({ storage: e.target.value as Storage })}
        >
          <option value="ok">storage ok</option>
          <option value="full">storage full</option>
          <option value="write-failed">storage write refused</option>
          <option value="unreadable">storage unreadable</option>
        </select>
        <select
          value={state.scenario.login}
          onChange={e => scenario({ login: e.target.value as Login })}
        >
          <option value="main">login @arnab.c (owner)</option>
          <option value="alt">login @arnab.alt (other)</option>
          <option value="unverified">login not verified</option>
        </select>
        <button onClick={() => setShowState(s => !s)}>state</button>
        {showState && (
          <pre className="pt-state">
            {JSON.stringify(
              {
                log: state.log,
                scenario: state.scenario,
                watches: state.watches.map(w => ({
                  id: w.id,
                  owner: w.ownerId,
                  enabled: w.enabled,
                  kinds: w.kinds,
                  actions: w.actions,
                })),
              },
              null,
              1
            )}
          </pre>
        )}
      </div>
    </>
  );
}
