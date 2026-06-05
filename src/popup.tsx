import { useState, useEffect, useCallback, useRef } from 'react';
import { Effect, Either } from 'effect';
import './styles.css';
import { browser } from './lib/browser';
import { captureFrameFromVideoEffect } from './effect/frame-extraction';

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

interface PreviewResponse {
  previewUrl?: string;
  error?: string;
}

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';
type VideoBlobResponse = { dataUrl?: string; error?: string };
type DownloadMediaResponse = { error?: string; failures?: { url: string; reason: string }[] };

export default function Popup() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('Awaiting URL.');
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [exportFrameSet, setExportFrameSet] = useState<Set<number>>(new Set());
  const [fallbackLoading, setFallbackLoading] = useState<Set<number>>(new Set());
  const [fallbackFailed, setFallbackFailed] = useState<Set<number>>(new Set());
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
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setMessage('No URL provided.');
      setStatus('error');
      return;
    }

    setStatus('fetching');
    setMessage('Fetching media…');

    try {
      const res = (await browser.runtime.sendMessage({
        type: 'FETCH_MEDIA',
        url: trimmedUrl,
      })) as MediaResponse;

      if (res?.error) {
        setMessage(res.error);
        setStatus('error');
        return;
      }

      applyFetchSuccess(res?.media ?? [], setMediaItems, setExportFrameSet, setStatus, setMessage);
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

  const requestFallbackPreview = useCallback(async (index: number, itemUrl: string) => {
    setFallbackLoading(prev => new Set(prev).add(index));

    try {
      const res = (await browser.runtime.sendMessage({
        type: 'GET_PREVIEW_URL',
        url: itemUrl,
      })) as PreviewResponse;

      if (res?.previewUrl) {
        setMediaItems(prev =>
          prev.map(item => (item.index === index ? { ...item, previewUrl: res.previewUrl } : item))
        );
        setFallbackFailed(prev => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      } else {
        setFallbackFailed(prev => new Set(prev).add(index));
      }
    } catch {
      setFallbackFailed(prev => new Set(prev).add(index));
    } finally {
      setFallbackLoading(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }, []);

  const captureFrameFromVideo = useCallback(
    (video: HTMLVideoElement) =>
      Effect.runPromise(captureFrameFromVideoEffect(video).pipe(Effect.either)),
    []
  );

  const handleExportFrame = useCallback(
    async (index: number) => {
      const video = videoRefs.current[index];
      if (!video) return;

      try {
        const res = (await browser.runtime.sendMessage({
          type: 'FETCH_VIDEO_BLOB',
          url: mediaItems[index]?.url,
        })) as VideoBlobResponse;

        const dataUrl = getVideoBlobDataUrl(res);
        const result = await captureFrameFromVideo(createExportVideo(dataUrl));
        if (Either.isLeft(result)) {
          setMessage(frameExportErrorMessage(result.left.reason));
          setStatus('error');
          return;
        }

        downloadBlobAsFile(result.right, `${mediaItems[index]?.filenameHint ?? 'media'}_frame.jpg`);
      } catch (err) {
        void err;
        setMessage('Frame export failed (CORS)');
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
      const standardItems = await exportSelectedFrames(selected, exportFrameSet, handleExportFrame);

      if (standardItems.length > 0) {
        const res = (await browser.runtime.sendMessage({
          type: 'DOWNLOAD_MEDIA',
          urls: standardItems.map(item => item.url),
          hints: standardItems.map(item => item.filenameHint),
          types: standardItems.map(item => item.type),
        })) as DownloadMediaResponse;

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
                  fallbackLoading={fallbackLoading.has(item.index)}
                  fallbackFailed={fallbackFailed.has(item.index)}
                  onError={() => {
                    if (
                      fallbackLoading.has(item.index) ||
                      fallbackFailed.has(item.index) ||
                      item.previewUrl?.startsWith('data:')
                    )
                      return;
                    void requestFallbackPreview(item.index, item.url);
                  }}
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

function applyFetchSuccess(
  media: NonNullable<MediaResponse['media']>,
  setMediaItems: React.Dispatch<React.SetStateAction<MediaItem[]>>,
  setExportFrameSet: React.Dispatch<React.SetStateAction<Set<number>>>,
  setStatus: React.Dispatch<React.SetStateAction<Status>>,
  setMessage: React.Dispatch<React.SetStateAction<string>>
) {
  const items = media.map((item, i) => ({
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
}

function getVideoBlobDataUrl(response: VideoBlobResponse): string {
  if (response?.error || !response?.dataUrl) {
    throw new Error('cors');
  }
  return response.dataUrl;
}

function createExportVideo(dataUrl: string) {
  const exportVideo = document.createElement('video');
  exportVideo.src = dataUrl;
  exportVideo.muted = true;
  exportVideo.playsInline = true;
  exportVideo.crossOrigin = 'anonymous';
  return exportVideo;
}

function frameExportErrorMessage(reason: string): string {
  switch (reason) {
    case 'no-duration':
      return 'Frame export failed (duration unavailable).';
    case 'no-frame':
      return 'Frame export failed (no video frame).';
    case 'no-canvas':
      return 'Frame export failed (canvas unavailable).';
    case 'no-blob':
      return 'Frame export failed (image export).';
    case 'timeout':
      return 'Frame export failed (timed out).';
    default:
      return 'Frame export failed.';
  }
}

function downloadBlobAsFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportSelectedFrames(
  selected: MediaItem[],
  exportFrameSet: Set<number>,
  handleExportFrame: (index: number) => Promise<void>
) {
  const standardItems: MediaItem[] = [];

  for (const item of selected) {
    if (item.type === 'video' && exportFrameSet.has(item.index)) {
      await handleExportFrame(item.index);
      continue;
    }
    standardItems.push(item);
  }

  return standardItems;
}

function MediaItemRow({
  item,
  fallbackLoading,
  fallbackFailed,
  onError,
  onToggle,
  exportFrame,
  onToggleExportFrame,
  onVideoRef,
}: {
  item: MediaItem;
  fallbackLoading: boolean;
  fallbackFailed: boolean;
  onError: () => void;
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
        ) : fallbackFailed ? (
          <div className="thumb-placeholder">
            <span className="thumb-icon">◻</span>
          </div>
        ) : (
          <img src={item.previewUrl ?? item.url} alt="Preview" onError={onError} />
        )}
        {fallbackLoading && !item.previewUrl && <span className="thumb-loading">···</span>}
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
