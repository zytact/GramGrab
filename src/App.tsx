import { useState, useCallback } from 'react';
import { parseInstagramUrl } from './lib/router';
import type { ParsedUrl } from './lib/router';
import { browser } from './lib/browser';

type Status = 'idle' | 'resolving' | 'fetching' | 'downloading' | 'done' | 'error';

interface AppProps {
  initialUrl?: string;
}

export default function App({ initialUrl = '' }: AppProps) {
  const [url, setUrl] = useState(initialUrl);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [debug, setDebug] = useState('');

  const handleDownload = useCallback(async () => {
    if (!url.trim()) {
      setMessage('Supply a link first.');
      setStatus('error');
      return;
    }

    setStatus('resolving');
    setMessage('');
    setDebug('');

    try {
      const parsed = parseInstagramUrl(url.trim() || initialUrl);

      if (!parsed) {
        setMessage('Invalid or unsupported link.');
        setStatus('error');
        return;
      }

      const msg = formatDetected(parsed);
      setDebug(_d => `[TRACK] ${msg}`);
      setStatus('fetching');

      const task = (await browser.runtime.sendMessage({
        type: 'DOWNLOAD',
        url: url.trim() || initialUrl,
        carouselIndex: parsed.carouselIndex,
      })) as { error?: string; media?: unknown[] };

      if (task.error) {
        setMessage(task.error);
        setStatus('error');
        return;
      }

      setMessage(
        `Acquired ${task.media?.length ?? 0} media asset${(task.media?.length ?? 0) !== 1 ? 's' : ''}.`
      );
      setStatus('done');
    } catch (err) {
      setMessage(String(err));
      setStatus('error');
    }
  }, [url]);

  const isBusy = status === 'resolving' || status === 'fetching';

  return (
    <div className="wrapper">
      <div className="glass-panel">
        {/* ── Header ── */}
        <header>
          <div className="logo-glitch">
            Insta
            <em style={{ fontStyle: 'italic', color: 'var(--brand)', fontWeight: 400 }}>ext</em>
          </div>
          <span className="badge">v2.0</span>
        </header>

        <div className="content">
          <p className="instruction">Extract media from any post, reel, or story.</p>

          <div className="input-wrapper">
            <input
              type="url"
              className="neo-input"
              placeholder="https://instagram.com/…"
              value={url}
              onChange={e => setUrl(e.currentTarget.value)}
              onKeyDown={e => e.key === 'Enter' && !isBusy && handleDownload()}
            />
            <div className="input-backdrop" />
          </div>

          <button className="action-btn" onClick={handleDownload} disabled={isBusy}>
            {isBusy && <span className="btn-spinner" />}
            <span className="btn-text">
              {status === 'resolving'
                ? 'Analyzing…'
                : status === 'fetching'
                  ? 'Extracting…'
                  : 'Extract Media'}
            </span>
            <div className="btn-glow" />
          </button>
        </div>

        {message && (
          <div className={`status-banner ${status === 'error' ? 'error' : 'success'}`}>
            <span className="indicator" />
            {message}
          </div>
        )}

        {debug && (
          <div className="telemetry">
            <pre>{debug}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDetected(parsed: ParsedUrl): string {
  if (parsed.type === 'story') return `Story / @${parsed.username}`;
  if (parsed.type === 'highlight') return `Highlight / ${parsed.highlightId}`;
  return `${capitalize(parsed.type)} / ${parsed.shortcode ?? ''}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
