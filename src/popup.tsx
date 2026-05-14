import { useState, useEffect, useCallback, useRef } from 'react';
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
  media?: { url: string; type: string; filenameHint: string; previewUrl?: string }[];
  error?: string;
}

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';

export default function Popup() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('Awaiting URL.');
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [exportFrameSet, setExportFrameSet] = useState<Set<number>>(new Set());
  const [autoDetected, setAutoDetected] = useState(false);
  const videoRefs = useRef<Record<number, HTMLVideoElement | null>>({});

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
        previewUrl: item.previewUrl,
      }));

      setMediaItems(items);
      setExportFrameSet(new Set());
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

  const toggleItem = useCallback((index: number) => {
    setMediaItems(prev =>
      prev.map(item => (item.index === index ? { ...item, selected: !item.selected } : item))
    );
  }, []);

  const toggleExportFrame = useCallback((index: number) => {
    setExportFrameSet(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const captureFrameFromVideo = useCallback(async (video: HTMLVideoElement) => {
    if (video.readyState < 1) {
      await new Promise<void>(resolve => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      });
    }

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('no-duration');
    }

    const targetTime = Math.min(5, video.duration);
    video.currentTime = targetTime;
    await new Promise<void>(resolve => {
      video.addEventListener('seeked', () => resolve(), { once: true });
    });

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('no-frame');
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('no-canvas');
    }

    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', 0.95);
    });

    if (!blob) {
      throw new Error('no-blob');
    }

    return blob;
  }, []);

  const handleExportFrame = useCallback(
    async (index: number) => {
      const video = videoRefs.current[index];
      if (!video) return;

      try {
        const res = (await browser.runtime.sendMessage({
          type: 'FETCH_VIDEO_BLOB',
          url: mediaItems[index]?.url,
        })) as { dataUrl?: string; error?: string };

        if (res?.error || !res?.dataUrl) {
          throw new Error('cors');
        }

        const exportVideo = document.createElement('video');
        exportVideo.src = res.dataUrl;
        exportVideo.muted = true;
        exportVideo.playsInline = true;
        exportVideo.crossOrigin = 'anonymous';
        const blob = await captureFrameFromVideo(exportVideo);

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${mediaItems[index]?.filenameHint ?? 'media'}_frame.jpg`;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        if (err instanceof Error && err.message === 'no-duration') {
          setMessage('Frame export failed (duration unavailable).');
        } else if (err instanceof Error && err.message === 'no-frame') {
          setMessage('Frame export failed (no video frame).');
        } else if (err instanceof Error && err.message === 'no-canvas') {
          setMessage('Frame export failed (canvas unavailable).');
        } else if (err instanceof Error && err.message === 'no-blob') {
          setMessage('Frame export failed (image export).');
        } else {
          setMessage('Frame export failed (CORS)');
        }
        setStatus('error');
      }
    },
    [captureFrameFromVideo, mediaItems]
  );

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
      const standardItems: MediaItem[] = [];

      for (const item of selected) {
        if (item.type === 'video' && exportFrameSet.has(item.index)) {
          await handleExportFrame(item.index);
        } else {
          standardItems.push(item);
        }
      }

      if (standardItems.length > 0) {
        const res = (await browser.runtime.sendMessage({
          type: 'DOWNLOAD_MEDIA',
          urls: standardItems.map(item => item.url),
          hints: standardItems.map(item => item.filenameHint),
          types: standardItems.map(item => item.type),
        })) as { error?: string };

        if (res?.error) {
          setMessage(res.error);
          setStatus('error');
          return;
        }
      }

      setMessage(
        `Downloaded ${selected.length} item${selected.length !== 1 ? 's' : ''} successfully.`
      );
      setStatus('done');
    } catch (err) {
      setMessage(String(err));
      setStatus('error');
    }
  }, [exportFrameSet, handleExportFrame, mediaItems]);

  const selectedCount = mediaItems.filter(m => m.selected).length;
  const allSelected = mediaItems.length > 0 && selectedCount === mediaItems.length;

  const toggleAll = useCallback(() => {
    const newSelected = !allSelected;
    setMediaItems(prev => prev.map(item => ({ ...item, selected: newSelected })));
  }, [allSelected]);

  const isBusy = status === 'fetching' || status === 'downloading';

  return (
    <div className="container">
      <header className="ext-header">
        <div className="ext-logo">
          Gram<em>Grab</em>
        </div>
        <div className="ext-meta">
          <span className="ext-subtitle">Media Extractor</span>
        </div>
      </header>

      <div className="ext-body">
        <div className="ext-section">
          <div className="field-label">Source URL</div>
          <input
            className={`url-input${autoDetected ? ' detected' : ''}`}
            type="url"
            placeholder="Paste an Instagram URL…"
            value={url}
            onChange={e => {
              setUrl(e.currentTarget.value);
              setAutoDetected(false);
            }}
            onKeyDown={e => e.key === 'Enter' && !isBusy && handleFetch()}
          />
        </div>

        <div className="ext-section">
          <button className="btn" onClick={handleFetch} disabled={isBusy}>
            {status === 'fetching' ? (
              <>
                <span className="btn-spinner" />
                Fetching…
              </>
            ) : (
              'Fetch Media'
            )}
          </button>
        </div>

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
                  onToggle={() => toggleItem(item.index)}
                  exportFrame={exportFrameSet.has(item.index)}
                  onToggleExportFrame={() => toggleExportFrame(item.index)}
                  onVideoRef={el => {
                    videoRefs.current[item.index] = el;
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div className="ext-section">
          <button className="btn" onClick={handleDownload} disabled={selectedCount === 0 || isBusy}>
            {status === 'downloading' ? (
              <>
                <span className="btn-spinner" />
                Downloading…
              </>
            ) : selectedCount > 0 ? (
              `Download ${selectedCount} Selected`
            ) : (
              'Download Selected'
            )}
          </button>
        </div>
      </div>

      <div className="status-bar">
        <span className={`status-dot ${status}`} />
        <span className={`status-text ${status}`}>{message}</span>
      </div>

      <footer className="ext-footer">
        <span className="footer-brand">GramGrab</span>
        <span className="footer-tagline">Posts · Reels · Stories</span>
      </footer>
    </div>
  );
}

function MediaItemRow({
  item,
  onToggle,
  exportFrame,
  onToggleExportFrame,
  onVideoRef,
}: {
  item: MediaItem;
  onToggle: () => void;
  exportFrame: boolean;
  onToggleExportFrame: () => void;
  onVideoRef: (el: HTMLVideoElement | null) => void;
}) {
  const num = String(item.index + 1).padStart(2, '0');

  return (
    <label
      className={`media-item${item.selected ? ' selected' : ''}`}
      style={{ gridTemplateColumns: '30px 56px 1fr 120px' }}
    >
      <span className="item-number">{num}</span>

      <div className="media-thumb">
        {item.type === 'video' ? (
          <>
            <video src={item.url} muted playsInline ref={onVideoRef} />
            <div className="play-overlay">
              <div className="play-triangle" />
            </div>
          </>
        ) : (
          <img src={item.previewUrl ?? item.url} alt="Preview" />
        )}
      </div>

      <div className="item-info">
        <span className={`item-type-badge ${item.type}`}>{item.type}</span>
        <span className="item-filename">{item.filenameHint}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
        {item.type === 'video' && (
          <label
            className="frame-toggle"
            title="Export frame on download"
            onClick={event => event.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={exportFrame}
              onChange={onToggleExportFrame}
              className="frame-toggle-checkbox"
            />
            Frame
          </label>
        )}
        <input
          className="item-checkbox"
          type="checkbox"
          checked={item.selected}
          onChange={onToggle}
          onClick={e => e.stopPropagation()}
        />
      </div>
    </label>
  );
}
