import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';

// Three Provenance overlay variants, switchable via ?variant=, on a dedicated throwaway evaluation page.

type VariantKey = 'A' | 'B' | 'C';
type FieldCount = 2 | 3;

interface VariantDefinition {
  key: VariantKey;
  name: string;
  summary: string;
  defaultOpacity: number;
}

interface MediaShape {
  key: string;
  name: string;
  dimensions: string;
  className: string;
}

const VARIANT_A: VariantDefinition = {
  key: 'A',
  name: 'Caption block',
  summary: 'Compact, left anchored, and hierarchy-led',
  defaultOpacity: 0.58,
};

const VARIANT_B: VariantDefinition = {
  key: 'B',
  name: 'Lower third',
  summary: 'Full-width, stable, and scan-first',
  defaultOpacity: 0.46,
};

const VARIANT_C: VariantDefinition = {
  key: 'C',
  name: 'Corner ledger',
  summary: 'Narrow, right aligned, and metadata-led',
  defaultOpacity: 0.64,
};

const VARIANTS: readonly VariantDefinition[] = [VARIANT_A, VARIANT_B, VARIANT_C];

const MEDIA_SHAPES: readonly MediaShape[] = [
  {
    key: 'portrait',
    name: 'Portrait Post',
    dimensions: '1080 × 1350',
    className: 'media-portrait',
  },
  {
    key: 'landscape',
    name: 'Landscape Post',
    dimensions: '1080 × 608',
    className: 'media-landscape',
  },
  {
    key: 'square',
    name: 'Square Post',
    dimensions: '1080 × 1080',
    className: 'media-square',
  },
  {
    key: 'small',
    name: 'Small image',
    dimensions: '320 × 240',
    className: 'media-small',
  },
  {
    key: 'video',
    name: 'Shortcode Reel',
    dimensions: '1080 × 1920',
    className: 'media-video',
  },
  {
    key: 'frame',
    name: 'Exported frame',
    dimensions: '1920 × 1080',
    className: 'media-frame',
  },
];

function isVariantKey(value: string | null): value is VariantKey {
  return value === 'A' || value === 'B' || value === 'C';
}

function readFieldCount(value: string | null): FieldCount {
  return value === '2' ? 2 : 3;
}

function readOpacity(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(0.8, Math.max(0.25, parsed));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && target.matches('input, textarea, [contenteditable="true"]')
  );
}

function arrowDirection(key: string): -1 | 1 | undefined {
  if (key === 'ArrowLeft') return -1;
  if (key === 'ArrowRight') return 1;
  return undefined;
}

function ProvenanceFields({ fieldCount }: { fieldCount: FieldCount }) {
  return (
    <>
      <span className="provenance-username">@archival_field_notes_2026</span>
      <span className="provenance-time">23 Feb 2021 · 09:30:47 UTC</span>
      {fieldCount === 3 ? (
        <span className="provenance-location">Victoria Memorial, Kolkata, West Bengal</span>
      ) : null}
    </>
  );
}

function ProvenanceOverlay({
  variant,
  fieldCount,
  opacity,
}: {
  variant: VariantKey;
  fieldCount: FieldCount;
  opacity: number;
}) {
  const panelStyle: CSSProperties = { backgroundColor: `rgba(0, 0, 0, ${opacity})` };

  return (
    <div
      className={`provenance-overlay provenance-overlay-${variant.toLowerCase()}`}
      style={panelStyle}
    >
      <ProvenanceFields fieldCount={fieldCount} />
    </div>
  );
}

function MediaCase({
  shape,
  variant,
  fieldCount,
  opacity,
}: {
  shape: MediaShape;
  variant: VariantKey;
  fieldCount: FieldCount;
  opacity: number;
}) {
  return (
    <figure className={`media-case media-case-${shape.key}`}>
      <div className={`media-stage ${shape.className}`}>
        <div className="scene-detail" aria-hidden="true" />
        <ProvenanceOverlay variant={variant} fieldCount={fieldCount} opacity={opacity} />
      </div>
      <figcaption>
        <span>{shape.name}</span>
        <span>{shape.dimensions}</span>
      </figcaption>
    </figure>
  );
}

function PrototypeSwitcher({
  current,
  onChange,
}: {
  current: VariantDefinition;
  onChange: (direction: -1 | 1) => void;
}) {
  return (
    <nav className="prototype-switcher" aria-label="Prototype variants">
      <button type="button" onClick={() => onChange(-1)} aria-label="Previous variant">
        ←
      </button>
      <span>
        <strong>{current.key}</strong>
        <span>{current.name}</span>
      </span>
      <button type="button" onClick={() => onChange(1)} aria-label="Next variant">
        →
      </button>
    </nav>
  );
}

function App() {
  const [search, setSearch] = useState(() => window.location.search);
  const parameters = useMemo(() => new URLSearchParams(search), [search]);
  const requestedVariant = parameters.get('variant');
  const variantKey = isVariantKey(requestedVariant) ? requestedVariant : 'A';
  const variant = VARIANTS.find(candidate => candidate.key === variantKey) ?? VARIANT_A;
  const fieldCount = readFieldCount(parameters.get('fields'));
  const opacity = readOpacity(parameters.get('opacity'), variant.defaultOpacity);

  function replaceParameters(next: URLSearchParams) {
    const nextSearch = `?${next.toString()}`;
    window.history.replaceState(null, '', nextSearch);
    setSearch(nextSearch);
  }

  function updateParameter(name: string, value: string) {
    const next = new URLSearchParams(parameters);
    next.set(name, value);
    replaceParameters(next);
  }

  function changeVariant(direction: -1 | 1) {
    const currentIndex = VARIANTS.findIndex(candidate => candidate.key === variant.key);
    const nextIndex = (currentIndex + direction + VARIANTS.length) % VARIANTS.length;
    const nextVariant = VARIANTS[nextIndex];
    if (!nextVariant) return;
    const next = new URLSearchParams(parameters);
    next.set('variant', nextVariant.key);
    next.delete('opacity');
    replaceParameters(next);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const direction = arrowDirection(event.key);
      if (direction === undefined || isEditableTarget(event.target)) return;
      changeVariant(direction);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <main className={`prototype-shell variant-${variant.key.toLowerCase()}`}>
      <header className="prototype-header">
        <div>
          <p className="prototype-kicker">GramGrab · decision prototype</p>
          <h1>How much media should provenance occupy?</h1>
        </div>
        <p className="prototype-question">
          Compare readability and obstruction across every supported output shape. Use the longest
          plausible values, then test both field sets and backing opacity.
        </p>
      </header>

      <section className="control-rail" aria-label="Prototype controls">
        <div className="active-variant">
          <span>Direction {variant.key}</span>
          <strong>{variant.name}</strong>
          <p>{variant.summary}</p>
        </div>

        <fieldset className="field-control">
          <legend>Fields</legend>
          <button
            type="button"
            aria-pressed={fieldCount === 2}
            onClick={() => updateParameter('fields', '2')}
          >
            2 · no location
          </button>
          <button
            type="button"
            aria-pressed={fieldCount === 3}
            onClick={() => updateParameter('fields', '3')}
          >
            3 · with location
          </button>
        </fieldset>

        <label className="opacity-control">
          <span>
            Backing opacity <output>{Math.round(opacity * 100)}%</output>
          </span>
          <input
            type="range"
            min="0.25"
            max="0.8"
            step="0.01"
            value={opacity}
            onChange={event => updateParameter('opacity', event.currentTarget.value)}
          />
        </label>

        <button
          className="reset-opacity"
          type="button"
          onClick={() => {
            const next = new URLSearchParams(parameters);
            next.delete('opacity');
            replaceParameters(next);
          }}
        >
          Reset to {Math.round(variant.defaultOpacity * 100)}%
        </button>
      </section>

      <section className="contact-sheet" aria-label="Media shape comparison">
        {MEDIA_SHAPES.map(shape => (
          <MediaCase
            key={shape.key}
            shape={shape}
            variant={variant.key}
            fieldCount={fieldCount}
            opacity={opacity}
          />
        ))}
      </section>

      <aside className="reading-note">
        <span>Stress case</span>
        <p>
          Every sample mixes bright, dark, quiet, and high-frequency regions. Judge the overlay at
          actual viewing size, especially the small image and vertical video.
        </p>
      </aside>

      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </main>
  );
}

const root = document.querySelector('#root');
if (root) createRoot(root).render(<App />);
