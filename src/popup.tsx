import { useState, useEffect, useCallback } from 'react';
import './styles.css';
import { browser } from './lib/browser';

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
  const [message, setMessage] = useState('Awaiting URL.');
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [previewLoading, setPreviewLoading] = useState<Set<number>>(new Set());
  const [autoDetected, setAutoDetected] = useState(false);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(tabs => {
        const active = tabs[0];
        const currentUrl = active?.url ?? '';
        if (currentUrl.includes('instagram.com')) {
          setUrl(currentUrl);
          setAutoDetected(true);
          setMessage('Instagram URL detected — ready to fetch.');
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
    setMessage('Fetching media…');

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
          ? `${items.length} item${items.length !== 1 ? 's' : ''} found — select and download.`
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
    setMessage(`Downloading ${selected.length} item${selected.length !== 1 ? 's' : ''}…`);

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

      setMessage(
        `Downloaded ${selected.length} item${selected.length !== 1 ? 's' : ''} successfully.`
      );
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
  const allSelected = mediaItems.length > 0 && selectedCount === mediaItems.length;

  const toggleAll = useCallback(() => {
    const newSelected = !allSelected;
    setMediaItems(prev => prev.map(item => ({ ...item, selected: newSelected })));
  }, [allSelected]);

  const isBusy = status === 'fetching' || status === 'downloading';

  return (
    <div className="container">
      {/* ── Header ── */}
      <header className="ext-header">
        <div className="ext-logo">
          Insta<em>ext</em>
        </div>
        <div className="ext-meta">
          <span className="ext-version">v2.0</span>
          <span className="ext-subtitle">Media Extractor</span>
        </div>
      </header>

      <div className="ext-body">
        {/* ── URL Input Section ── */}
        <div className="ext-section">
          <div className="field-label">Source URL</div>
          <input
            className={`url-input${autoDetected ? ' detected' : ''}`}
            type="url"
            placeholder="Paste Instagram URL…"
            value={url}
            onChange={e => {
              setUrl(e.currentTarget.value);
              setAutoDetected(false);
            }}
            onKeyDown={e => e.key === 'Enter' && !isBusy && handleFetch()}
          />
        </div>

        {/* ── Fetch Button ── */}
        <div className="ext-section">
          <button className="btn" onClick={handleFetch} disabled={isBusy}>
            {status === 'fetching' ? (
              <>
                <span className="btn-spinner" />
                Fetching…
              </>
            ) : (
              <>
                <span className="btn-icon">⬇</span>
                Fetch Media
              </>
            )}
          </button>
        </div>

        {/* ── Media List Section ── */}
        <div className="ext-section" style={{ flex: 1 }}>
          {mediaItems.length > 0 && (
            <div className="media-header">
              <span className="media-count-label">
                <strong>{mediaItems.length}</strong> item{mediaItems.length !== 1 ? 's' : ''} found
              </span>
              <label className="select-all-label">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                Select all
              </label>
            </div>
          )}

          <div className="media-list">
            {mediaItems.length === 0 ? (
              <p className="media-empty">No media yet.</p>
            ) : (
              mediaItems.map(item => (
                <MediaItemRow
                  key={item.index}
                  item={item}
                  loading={previewLoading.has(item.index)}
                  onToggle={() => toggleItem(item.index)}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Download Button ── */}
        <div className="ext-section">
          <button className="btn" onClick={handleDownload} disabled={selectedCount === 0 || isBusy}>
            {status === 'downloading' ? (
              <>
                <span className="btn-spinner" />
                Downloading…
              </>
            ) : (
              <>
                <span className="btn-icon">↓</span>
                {selectedCount > 0 ? `Download ${selectedCount} Selected` : 'Download Selected'}
              </>
            )}
          </button>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div className="status-bar">
        <span className={`status-dot ${status}`} />
        <span className={`status-text ${status}`}>{message}</span>
      </div>

      {/* ── Footer ── */}
      <footer className="ext-footer">
        <span className="footer-brand">Instaext</span>
        <span className="footer-tagline">Posts · Reels · Stories</span>
      </footer>
    </div>
  );
}

function MediaItemRow({
  item,
  loading,
  onToggle,
}: {
  item: MediaItem;
  loading: boolean;
  onToggle: () => void;
}) {
  const num = String(item.index + 1).padStart(2, '0');

  return (
    <label className={`media-item${item.selected ? ' selected' : ''}`}>
      <span className="item-number">{num}</span>

      <div className="media-thumb">
        {item.type === 'video' ? (
          <>
            <video src={item.url} muted playsInline />
            <div className="play-overlay">
              <div className="play-triangle" />
            </div>
          </>
        ) : item.previewUrl ? (
          <img src={item.previewUrl} alt="Preview" />
        ) : loading ? (
          <span className="thumb-loading">···</span>
        ) : (
          <div className="thumb-placeholder">
            <span className="thumb-icon">◻</span>
          </div>
        )}
      </div>

      <div className="item-info">
        <span className={`item-type-badge ${item.type}`}>{item.type}</span>
        <span className="item-filename">{item.filenameHint}</span>
      </div>

      <input
        className="item-checkbox"
        type="checkbox"
        checked={item.selected}
        onChange={onToggle}
        onClick={e => e.stopPropagation()}
      />
    </label>
  );
}
