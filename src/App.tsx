import { useState, useCallback } from 'react';
import { parseInstagramUrl } from './lib/router';
import type { ParsedUrl } from './lib/router';

type Status = 'idle' | 'resolving' | 'fetching' | 'downloading' | 'done' | 'error';

interface AppProps {
  initialUrl?: string;
}

export default function App({ initialUrl = '' }: AppProps) {
  const [url, setUrl] = useState(initialUrl);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [count, setCount] = useState(0);
  const [debug, setDebug] = useState('');

  const handleDownload = useCallback(async () => {
    if (!url.trim()) {
      setMessage('No URL provided.');
      setStatus('error');
      return;
    }

    setStatus('resolving');
    setMessage('');
    setCount(0);
    setDebug('');

    try {
      const parsed = parseInstagramUrl(url.trim() || initialUrl);

      if (!parsed) {
        setMessage('Not a supported Instagram URL.');
        setStatus('error');
        return;
      }

      const msg = formatDetected(parsed);
      setDebug(_d => `Detected: ${msg}`);
      setStatus('fetching');

      const task = await browser.runtime.sendMessage({
        type: 'DOWNLOAD',
        url: url.trim() || initialUrl,
        carouselIndex: parsed.carouselIndex,
      });

      if (task.error) {
        setMessage(task.error);
        setStatus('error');
        return;
      }

      setCount(task.media?.length ?? 0);
      setMessage(`Found ${task.media?.length ?? 0} media item(s)`);
      setStatus('done');
    } catch (err) {
      setMessage(String(err));
      setStatus('error');
    }
  }, [url]);

  return (
    <div className="container">
      <header>InstaSave</header>
      <p className="hint">Paste an Instagram post, reel, story, or highlight URL.</p>
      <div className="input-group">
        <input
          type="url"
          placeholder="Instagram post / reel / story URL"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleDownload()}
        />
      </div>
      <div className="row">
        <button onClick={handleDownload} disabled={status === 'resolving' || status === 'fetching'}>
          {status === 'resolving'
            ? 'Resolving...'
            : status === 'fetching'
              ? 'Fetching...'
              : 'Download'}
        </button>
      </div>
      {message && <p className={`msg ${status === 'error' ? 'error' : 'info'}`}>{message}</p>}
      {count > 0 && <p className="msg success">{count} item(s) saved to Downloads</p>}
      {debug && <pre className="debug">{debug}</pre>}
    </div>
  );
}

function formatDetected(parsed: ParsedUrl): string {
  if (parsed.type === 'story') return `Story — @${parsed.username}`;
  if (parsed.type === 'highlight') return `Highlight — ${parsed.highlightId}`;
  return `${capitalize(parsed.type)} — ${parsed.shortcode ?? ''}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
