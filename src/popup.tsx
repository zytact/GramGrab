import { useState, useEffect, useCallback } from 'react';
import './styles.css';

interface MediaItem {
  index: number;
  type: string;
  url: string;
  filenameHint: string;
  selected: boolean;
  previewUrl?: string;
}

interface MediaResponse {
  media?: { url: string; type: string; filenameHint: string }[];
  error?: string;
}

interface PreviewResponse {
  previewUrl?: string;
  error?: string;
}

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';

export default function Popup() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('Ready.');
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [previewLoading, setPreviewLoading] = useState<Set<number>>(new Set());

  useEffect(() => {
    browser.tabs
      ?.query({ active: true, currentWindow: true })
      .then(tabs => {
        const active = tabs[0];
        const currentUrl = active?.url ?? '';
        if (currentUrl.includes('instagram.com')) {
          setUrl(currentUrl);
          setMessage('Instagram URL detected. Click Fetch Media.');
        }
      })
      .catch(() => {});
  }, []);

  const handleFetch = useCallback(async () => {
    if (!url.trim()) {
      setMessage('No URL provided.');
      setStatus('error');
      return;
    }

    setStatus('fetching');
    setMessage('Fetching media...');

    try {
      const res = (await browser.runtime.sendMessage({
        type: 'FETCH_MEDIA',
        url: url.trim(),
      })) as MediaResponse;

      if (res?.error) {
        setMessage(res.error);
        setStatus('error');
        return;
      }

      const items = (res?.media ?? []).map((item, i) => ({
        index: i,
        type: item.type,
        url: item.url,
        filenameHint: item.filenameHint,
        selected: true,
      }));

      setMediaItems(items);
      setStatus(items.length > 0 ? 'done' : 'error');
      setMessage(
        items.length > 0
          ? `Found ${items.length} item(s). Select and download.`
          : 'No downloadable media found.'
      );
    } catch (err) {
      setMessage(String(err));
      setStatus('error');
    }
  }, [url]);

  const handleDownload = useCallback(async () => {
    const selected = mediaItems.filter(m => m.selected);
    if (selected.length === 0) {
      setMessage('No items selected.');
      setStatus('error');
      return;
    }

    setStatus('downloading');
    setMessage(`Downloading ${selected.length} item(s)...`);

    try {
      const res = (await browser.runtime.sendMessage({
        type: 'DOWNLOAD_MEDIA',
        urls: selected.map(m => m.url),
        hints: selected.map(m => m.filenameHint),
        types: selected.map(m => m.type),
      })) as { error?: string };

      if (res?.error) {
        setMessage(res.error);
        setStatus('error');
        return;
      }

      setMessage(`Downloaded ${selected.length} item(s).`);
      setStatus('done');
    } catch (err) {
      setMessage(String(err));
      setStatus('error');
    }
  }, [mediaItems]);

  const toggleItem = useCallback((index: number) => {
    setMediaItems(prev =>
      prev.map(item => (item.index === index ? { ...item, selected: !item.selected } : item))
    );
  }, []);

  const loadPreview = useCallback(async (index: number, itemUrl: string) => {
    setPreviewLoading(prev => new Set(prev).add(index));

    try {
      const res = (await browser.runtime.sendMessage({
        type: 'GET_PREVIEW_URL',
        url: itemUrl,
      })) as PreviewResponse;

      if (res?.previewUrl) {
        setMediaItems(prev =>
          prev.map(item => (item.index === index ? { ...item, previewUrl: res.previewUrl } : item))
        );
      }
    } finally {
      setPreviewLoading(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    mediaItems.forEach((item, idx) => {
      if (item.type === 'image' && !item.previewUrl) {
        loadPreview(idx, item.url);
      }
    });
  }, [mediaItems, loadPreview]);

  const selectedCount = mediaItems.filter(m => m.selected).length;

  return (
    <div className="container">
      <header>Instaext</header>
      <p className="hint">Instagram post, reel, story, or highlight URL</p>
      <div className="input-group">
        <input
          type="url"
          placeholder="Paste URL or auto-detected from tab"
          value={url}
          onChange={e => setUrl(e.target.value)}
        />
      </div>
      <div className="row">
        <button onClick={handleFetch} disabled={status === 'fetching' || status === 'downloading'}>
          {status === 'fetching' ? 'Fetching...' : 'Fetch Media'}
        </button>
      </div>
      <div className="media-list">
        {mediaItems.length === 0 ? (
          <p className="hint">No media found.</p>
        ) : (
          mediaItems.map(item => (
            <MediaItemComponent
              key={item.index}
              item={item}
              loading={previewLoading.has(item.index)}
              onToggle={() => toggleItem(item.index)}
            />
          ))
        )}
      </div>
      <div className="row">
        <button
          onClick={handleDownload}
          disabled={selectedCount === 0 || status === 'fetching' || status === 'downloading'}
        >
          {selectedCount > 0 ? `Download Selected (${selectedCount})` : 'Download Selected'}
        </button>
      </div>
      <p className={`msg ${status === 'error' ? 'error' : status === 'done' ? 'success' : 'info'}`}>
        {message}
      </p>
    </div>
  );
}

function MediaItemComponent({
  item,
  loading,
  onToggle,
}: {
  item: MediaItem;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="media-item">
      <input type="checkbox" checked={item.selected} onChange={onToggle} />
      <div className="media-preview">
        {item.type === 'video' ? (
          <>
            <video src={item.url} muted playsInline />
            <div className="play-icon">▶</div>
          </>
        ) : item.previewUrl ? (
          <img src={item.previewUrl} alt="Preview" />
        ) : loading ? (
          <span className="preview-loading">Loading...</span>
        ) : (
          <div className="preview-placeholder">
            <span className="preview-icon">📷</span>
            <span className="preview-text">Loading preview...</span>
          </div>
        )}
      </div>
      <div className="media-info">
        <span className="media-type">{item.type}</span>
        <span className="media-hint">{item.filenameHint}</span>
      </div>
    </label>
  );
}
