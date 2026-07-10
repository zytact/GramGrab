import { useState, useCallback, useRef, type CSSProperties } from 'react';
import { Effect, Either } from 'effect';
import './styles.css';
import { browser } from './lib/browser';
import { captureFrameFromVideoEffect } from './effect/frame-extraction';
import { isBusy as isWorkspaceBusy } from './workspace/contracts';
import { useMediaFetch } from './workspace/use-media-fetch';
import { useWorkspaceSurface } from './workspace/use-workspace-surface';
import { isPositiveFinitePair, resolveMediaRatio } from './workspace/media-ratio';

interface MediaItem {
  index: number;
  type: string;
  url: string;
  filenameHint: string;
  selected: boolean;
  previewUrl?: string;
  width?: number;
  height?: number;
}

interface PreviewResponse {
  previewUrl?: string;
  error?: string;
}

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';
type VideoBlobResponse = { dataUrl?: string; error?: string };
type DownloadMediaResponse = { error?: string; failures?: { url: string; reason: string }[] };

export default function Popup() {
  const initialWorkspaceMode =
    new URLSearchParams(window.location.search).get('surface') === 'workspace';
  const [url, setUrl] = useState(() =>
    initialWorkspaceMode ? (new URLSearchParams(window.location.search).get('source') ?? '') : ''
  );
  const [fetchedUrl, setFetchedUrl] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('Awaiting URL.');
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [exportFrameSet, setExportFrameSet] = useState<Set<number>>(new Set());
  const [fallbackLoading, setFallbackLoading] = useState<Set<number>>(new Set());
  const [fallbackFailed, setFallbackFailed] = useState<Set<number>>(new Set());
  const [intrinsicDimensions, setIntrinsicDimensions] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const [autoDetected, setAutoDetected] = useState(false);
  const videoRefs = useRef<Record<number, HTMLVideoElement | null>>({});

  const replaceMediaItems = useCallback<typeof setMediaItems>(action => {
    setIntrinsicDimensions({});
    setMediaItems(action);
  }, []);

  const handleFetch = useMediaFetch({
    url,
    setFetchedUrl,
    setMediaItems: replaceMediaItems,
    setExportFrameSet,
    setStatus,
    setMessage,
  });

  const handleIntrinsicDimensions = useCallback(
    (item: MediaItem, width: number, height: number) => {
      if (isPositiveFinitePair(item.width, item.height) || !isPositiveFinitePair(width, height))
        return;
      setIntrinsicDimensions(previous => {
        const existing = previous[item.index];
        if (existing?.width === width && existing.height === height) return previous;
        return { ...previous, [item.index]: { width, height } };
      });
    },
    []
  );

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

  const isBusy = isWorkspaceBusy(status);
  const handleUrlChange = useCallback((nextUrl: string) => {
    setUrl(nextUrl);
    setAutoDetected(false);
  }, []);
  const handlePreviewError = useCallback(
    (item: MediaItem) => {
      if (shouldSkipFallbackPreview(item, fallbackLoading, fallbackFailed)) return;
      void requestFallbackPreview(item.index, item.url);
    },
    [fallbackFailed, fallbackLoading, requestFallbackPreview]
  );
  const handleVideoRef = useCallback((index: number, el: HTMLVideoElement | null) => {
    videoRefs.current[index] = el;
  }, []);

  const {
    workspaceMode,
    workspaceExists,
    confirmReplace,
    setConfirmReplace,
    handleOpenWorkspace,
    handleReplaceWorkspace,
    hasTransferableSession,
  } = useWorkspaceSurface({
    url,
    setUrl,
    fetchedUrl,
    setFetchedUrl,
    status,
    setStatus,
    message,
    setMessage,
    mediaItems,
    setMediaItems,
    exportFrameSet,
    setExportFrameSet,
    setAutoDetected,
  });

  return (
    <div className={`container${workspaceMode ? ' workspace-container' : ''}`}>
      <header className="ext-header">
        <PopupHeader
          workspaceMode={workspaceMode}
          workspaceExists={workspaceExists}
          isBusy={isBusy}
          onOpenWorkspace={handleOpenWorkspace}
        />
      </header>

      <div className="ext-body">
        <div className="ext-section">
          <div className="field-label">Source URL</div>
          <input
            className={`url-input${autoDetected ? ' detected' : ''}`}
            type="url"
            placeholder="Paste an Instagram URL…"
            value={url}
            onChange={e => handleUrlChange(e.currentTarget.value)}
            onKeyDown={e => e.key === 'Enter' && !isBusy && handleFetch()}
          />
        </div>

        <div className="ext-section">
          <button className="btn" onClick={handleFetch} disabled={isBusy}>
            {renderFetchButtonLabel(status)}
          </button>
        </div>

        <MediaListSection
          mediaItems={mediaItems}
          workspaceMode={workspaceMode}
          intrinsicDimensions={intrinsicDimensions}
          allSelected={allSelected}
          fallbackLoading={fallbackLoading}
          fallbackFailed={fallbackFailed}
          exportFrameSet={exportFrameSet}
          onPreviewError={handlePreviewError}
          onToggle={toggleItem}
          onToggleAll={toggleAll}
          onToggleExportFrame={toggleExportFrame}
          onVideoRef={handleVideoRef}
          onIntrinsicDimensions={handleIntrinsicDimensions}
        />

        <div className="ext-section">
          <button className="btn" onClick={handleDownload} disabled={selectedCount === 0 || isBusy}>
            {renderDownloadButtonLabel(status, selectedCount)}
          </button>
        </div>
      </div>

      <div className="status-bar">
        <span className={`status-dot ${status}`} />
        <span className={`status-text ${status}`}>{message}</span>
      </div>

      <WorkspaceActions
        workspaceMode={workspaceMode}
        selectedCount={selectedCount}
        mediaCount={mediaItems.length}
        allSelected={allSelected}
        isBusy={isBusy}
        isDownloading={status === 'downloading'}
        onToggleAll={toggleAll}
        onDownload={handleDownload}
        workspaceExists={workspaceExists}
        hasTransferableSession={hasTransferableSession}
        confirmReplace={confirmReplace}
        setConfirmReplace={setConfirmReplace}
        onReplace={handleReplaceWorkspace}
      />

      <footer className="ext-footer">
        <span className="footer-brand">GramGrab</span>
        <span className="footer-tagline">Posts · Reels · Stories</span>
      </footer>
    </div>
  );
}

function PopupHeader({
  workspaceMode,
  workspaceExists,
  isBusy,
  onOpenWorkspace,
}: {
  workspaceMode: boolean;
  workspaceExists: boolean;
  isBusy: boolean;
  onOpenWorkspace: () => Promise<void>;
}) {
  return (
    <>
      <div className="ext-logo">
        Gram<em>Grab</em>
      </div>
      <div className="ext-meta">
        <span className="ext-subtitle">Media Extractor</span>
        {!workspaceMode && (
          <button
            className="workspace-launch"
            type="button"
            onClick={() => void onOpenWorkspace()}
            disabled={isBusy}
            title={
              isBusy ? 'Finish the current operation before opening the workspace.' : undefined
            }
          >
            {workspaceExists ? 'Go to tab' : 'Open in tab'}
          </button>
        )}
      </div>
    </>
  );
}

function WorkspaceActions({
  workspaceMode,
  selectedCount,
  mediaCount,
  allSelected,
  isBusy,
  isDownloading,
  onToggleAll,
  onDownload,
  workspaceExists,
  hasTransferableSession,
  confirmReplace,
  setConfirmReplace,
  onReplace,
}: {
  workspaceMode: boolean;
  selectedCount: number;
  mediaCount: number;
  allSelected: boolean;
  isBusy: boolean;
  isDownloading: boolean;
  onToggleAll: () => void;
  onDownload: () => Promise<void>;
  workspaceExists: boolean;
  hasTransferableSession: boolean;
  confirmReplace: boolean;
  setConfirmReplace: (value: boolean) => void;
  onReplace: () => Promise<void>;
}) {
  if (workspaceMode) {
    return (
      <div className="workspace-action-bar">
        <span>{selectedCount} selected</span>
        <button
          type="button"
          className="workspace-secondary"
          onClick={onToggleAll}
          disabled={!mediaCount}
        >
          {allSelected ? 'Clear all' : 'Select all'}
        </button>
        <button
          type="button"
          className="workspace-download"
          onClick={() => void onDownload()}
          disabled={selectedCount === 0 || isBusy}
        >
          {isDownloading ? 'Downloading…' : 'Download selected'}
        </button>
      </div>
    );
  }
  if (!workspaceExists || !hasTransferableSession) return null;
  return (
    <div className="workspace-replace">
      {confirmReplace ? (
        <div
          role="alertdialog"
          aria-label="Replace workspace session"
          onKeyDown={event => event.key === 'Escape' && setConfirmReplace(false)}
        >
          <span>Replace the current workspace session?</span>
          <button type="button" onClick={() => void onReplace()}>
            Replace
          </button>
          <button type="button" onClick={() => setConfirmReplace(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirmReplace(true)} disabled={isBusy}>
          Replace tab session
        </button>
      )}
    </div>
  );
}

function shouldSkipFallbackPreview(
  item: MediaItem,
  fallbackLoading: Set<number>,
  fallbackFailed: Set<number>
): boolean {
  return (
    fallbackLoading.has(item.index) ||
    fallbackFailed.has(item.index) ||
    item.previewUrl?.startsWith('data:') === true
  );
}

function renderDownloadButtonLabel(status: Status, selectedCount: number) {
  if (status === 'downloading') {
    return (
      <>
        <span className="btn-spinner" />
        Downloading…
      </>
    );
  }

  return selectedCount > 0 ? `Download ${selectedCount} Selected` : 'Download Selected';
}

function renderFetchButtonLabel(status: Status) {
  return status === 'fetching' ? (
    <>
      <span className="btn-spinner" />
      Fetching…
    </>
  ) : (
    'Fetch Media'
  );
}

function MediaListSection({
  mediaItems,
  workspaceMode,
  intrinsicDimensions,
  allSelected,
  fallbackLoading,
  fallbackFailed,
  exportFrameSet,
  onPreviewError,
  onToggle,
  onToggleAll,
  onToggleExportFrame,
  onVideoRef,
  onIntrinsicDimensions,
}: {
  mediaItems: MediaItem[];
  workspaceMode: boolean;
  intrinsicDimensions: Record<number, { width: number; height: number }>;
  allSelected: boolean;
  fallbackLoading: Set<number>;
  fallbackFailed: Set<number>;
  exportFrameSet: Set<number>;
  onPreviewError: (item: MediaItem) => void;
  onToggle: (index: number) => void;
  onToggleAll: () => void;
  onToggleExportFrame: (index: number) => void;
  onVideoRef: (index: number, el: HTMLVideoElement | null) => void;
  onIntrinsicDimensions: (item: MediaItem, width: number, height: number) => void;
}) {
  return (
    <div className="ext-section" style={{ flex: 1 }}>
      {mediaItems.length > 0 && (
        <div className="media-header">
          <span className="media-count-label">
            <strong>{mediaItems.length}</strong> item{mediaItems.length !== 1 ? 's' : ''} found
          </span>
          <label className="select-all-label">
            <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
            Select all
          </label>
        </div>
      )}

      <div className={`media-list${workspaceMode ? ' workspace-media-list' : ''}`}>
        {mediaItems.length === 0 ? (
          <p className="media-empty">No media yet.</p>
        ) : (
          mediaItems.map(item => (
            <MediaItemRow
              key={item.index}
              item={item}
              workspaceMode={workspaceMode}
              intrinsicDimensions={intrinsicDimensions[item.index]}
              fallbackLoading={fallbackLoading.has(item.index)}
              fallbackFailed={fallbackFailed.has(item.index)}
              onError={() => onPreviewError(item)}
              onToggle={() => onToggle(item.index)}
              exportFrame={exportFrameSet.has(item.index)}
              onToggleExportFrame={() => onToggleExportFrame(item.index)}
              onVideoRef={el => onVideoRef(item.index, el)}
              onIntrinsicDimensions={(width, height) => onIntrinsicDimensions(item, width, height)}
            />
          ))
        )}
      </div>
    </div>
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
  workspaceMode,
  intrinsicDimensions,
  fallbackLoading,
  fallbackFailed,
  onError,
  onToggle,
  exportFrame,
  onToggleExportFrame,
  onVideoRef,
  onIntrinsicDimensions,
}: {
  item: MediaItem;
  workspaceMode: boolean;
  intrinsicDimensions?: { width: number; height: number };
  fallbackLoading: boolean;
  fallbackFailed: boolean;
  onError: () => void;
  onToggle: () => void;
  exportFrame: boolean;
  onToggleExportFrame: () => void;
  onVideoRef: (el: HTMLVideoElement | null) => void;
  onIntrinsicDimensions: (width: number, height: number) => void;
}) {
  const num = String(item.index + 1).padStart(2, '0');
  const ratio = resolveMediaRatio(
    item.width,
    item.height,
    intrinsicDimensions?.width,
    intrinsicDimensions?.height
  );
  const previewStyle = workspaceMode ? ({ '--media-ratio': ratio } as CSSProperties) : undefined;

  return (
    <label className={`media-item${item.selected ? ' selected' : ''}`}>
      <span className="item-number">{num}</span>

      <div className="media-thumb" style={previewStyle}>
        {item.type === 'video' ? (
          <>
            <video
              src={item.url}
              muted
              playsInline
              ref={onVideoRef}
              onLoadedMetadata={event =>
                onIntrinsicDimensions(
                  event.currentTarget.videoWidth,
                  event.currentTarget.videoHeight
                )
              }
            />
            <div className="play-overlay">
              <div className="play-triangle" />
            </div>
          </>
        ) : fallbackFailed ? (
          <div className="thumb-placeholder">
            <span className="thumb-icon">◻</span>
          </div>
        ) : (
          <img
            src={item.previewUrl ?? item.url}
            alt="Preview"
            onLoad={event =>
              onIntrinsicDimensions(
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight
              )
            }
            onError={onError}
          />
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
