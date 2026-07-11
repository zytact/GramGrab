import { useState, useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Effect, Either } from 'effect';
import './styles.css';
import { browser } from './lib/browser';
import { captureFrameFromVideoEffect } from './effect/frame-extraction';
import { runFrameExportBatch } from './frame-export/batch';
import {
  clampFrameSecond,
  defaultFrameSecond,
  frameFilename,
  frameTimestampAriaValue,
  formatFrameTimestamp,
  maximumFrameSecond,
  type FrameExportSetting,
} from './frame-export/timestamp';
import { canonicalizeInstagramUrl, isBusy as isWorkspaceBusy } from './workspace/contracts';
import { useMediaFetch } from './workspace/use-media-fetch';
import { useWorkspaceSurface } from './workspace/use-workspace-surface';
import { isPositiveFinitePair, resolveMediaRatio } from './workspace/media-ratio';
import { distributeMasonryItems } from './workspace/masonry';

interface MediaItem {
  index: number;
  itemIndex?: number;
  mediaId?: string;
  history?: { downloaded: boolean; count: number; latestDownloadedAt?: number };
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
type FrameRuntime = {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'exporting';
  durationSeconds?: number;
  dataUrl?: string;
  error?: string;
  warning?: string;
};
type DownloadMediaResponse = {
  error?: string;
  failures?: { url: string; reason: string }[];
  acceptedItemIndexes?: number[];
};
type HistoryEntry = {
  id: string;
  sourceUrl: string;
  sourceKind: string;
  itemIndex: number;
  mediaType: string;
  filenameHint: string;
  exportMode?: 'direct' | 'frame';
  frameTimestampSeconds?: number;
  downloadedAt: number;
};

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
  const [frameExportSettings, setFrameExportSettings] = useState<
    Record<number, FrameExportSetting>
  >({});
  const [frameRuntime, setFrameRuntime] = useState<Record<number, FrameRuntime>>({});
  const [fallbackLoading, setFallbackLoading] = useState<Set<number>>(new Set());
  const [fallbackFailed, setFallbackFailed] = useState<Set<number>>(new Set());
  const [intrinsicDimensions, setIntrinsicDimensions] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const [autoDetected, setAutoDetected] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const videoRefs = useRef<Record<number, HTMLVideoElement | null>>({});
  const resultsGeneration = useRef(0);
  const pendingFrameDefaults = useRef(new Set<number>());

  const replaceMediaItems = useCallback<typeof setMediaItems>(action => {
    resultsGeneration.current++;
    pendingFrameDefaults.current.clear();
    setIntrinsicDimensions({});
    setFrameRuntime({});
    setMediaItems(action);
  }, []);

  const handleFetch = useMediaFetch({
    url,
    setFetchedUrl,
    setMediaItems: replaceMediaItems,
    setFrameExportSettings,
    setStatus,
    setMessage,
  });
  const handleFetchRef = useRef(handleFetch);

  useEffect(() => {
    handleFetchRef.current = handleFetch;
  }, [handleFetch]);

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

  const setFrameDuration = useCallback((index: number, durationSeconds: number) => {
    const maximum = maximumFrameSecond(durationSeconds);
    if (maximum === undefined) return;
    setFrameRuntime(previous => ({
      ...previous,
      [index]: { ...previous[index], status: 'ready', durationSeconds, error: undefined },
    }));
    setFrameExportSettings(previous => {
      const setting = previous[index];
      if (!setting) return previous;
      return {
        ...previous,
        [index]: {
          ...setting,
          timestampSeconds: clampFrameSecond(
            pendingFrameDefaults.current.delete(index)
              ? defaultFrameSecond(durationSeconds)
              : setting.timestampSeconds,
            durationSeconds
          ),
        },
      };
    });
  }, []);

  const loadFrameMetadata = useCallback(
    // fallow-ignore-next-line complexity
    async (index: number) => {
      const generation = resultsGeneration.current;
      const itemUrl = mediaItems[index]?.url;
      if (!itemUrl) return;
      const video = videoRefs.current[index];
      if (video && maximumFrameSecond(video.duration) !== undefined) {
        setFrameDuration(index, video.duration);
        return;
      }
      setFrameRuntime(previous => ({ ...previous, [index]: { status: 'loading' } }));
      try {
        const response = (await browser.runtime.sendMessage({
          type: 'FETCH_VIDEO_BLOB',
          url: itemUrl,
        })) as VideoBlobResponse;
        const dataUrl = getVideoBlobDataUrl(response);
        const durationSeconds = await getVideoDuration(dataUrl);
        if (generation !== resultsGeneration.current || mediaItems[index]?.url !== itemUrl) return;
        setFrameRuntime(previous => ({
          ...previous,
          [index]: { status: 'ready', durationSeconds, dataUrl },
        }));
        setFrameExportSettings(previous => {
          const setting = previous[index];
          if (!setting) return previous;
          return {
            ...previous,
            [index]: {
              ...setting,
              timestampSeconds: clampFrameSecond(
                pendingFrameDefaults.current.delete(index)
                  ? defaultFrameSecond(durationSeconds)
                  : setting.timestampSeconds,
                durationSeconds
              ),
            },
          };
        });
      } catch {
        if (generation !== resultsGeneration.current || mediaItems[index]?.url !== itemUrl) return;
        setFrameRuntime(previous => ({
          ...previous,
          [index]: { status: 'failed', error: 'Could not load video metadata. Retry.' },
        }));
      }
    },
    [mediaItems, setFrameDuration]
  );

  const toggleExportFrame = useCallback(
    (index: number) => {
      const enabled = !frameExportSettings[index]?.enabled;
      setFrameExportSettings(previous => ({
        ...previous,
        [index]: {
          enabled,
          timestampSeconds: previous[index]?.timestampSeconds ?? 0,
        },
      }));
      if (!frameExportSettings[index]) pendingFrameDefaults.current.add(index);
      if (enabled) void loadFrameMetadata(index);
    },
    [frameExportSettings, loadFrameMetadata]
  );

  const changeFrameTimestamp = useCallback((index: number, timestampSeconds: number) => {
    setFrameExportSettings(previous => ({
      ...previous,
      [index]: { enabled: true, timestampSeconds },
    }));
    setFrameRuntime(previous => ({
      ...previous,
      [index]: { ...previous[index], error: undefined, warning: undefined, status: 'ready' },
    }));
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      for (const [index, setting] of Object.entries(frameExportSettings)) {
        const duration = frameRuntime[Number(index)]?.durationSeconds;
        const video = videoRefs.current[Number(index)];
        if (!setting.enabled || duration === undefined || !video) continue;
        const target = clampFrameSecond(setting.timestampSeconds, duration);
        if (Math.abs(video.currentTime - target) > 0.01) video.currentTime = target;
      }
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [frameExportSettings, frameRuntime]);

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
    (video: HTMLVideoElement, timestampSeconds: number) =>
      Effect.runPromise(captureFrameFromVideoEffect(video, timestampSeconds).pipe(Effect.either)),
    []
  );
  const captureFrameFromDataUrl = useCallback(
    async (dataUrl: string, timestampSeconds: number) => {
      const video = createExportVideo(dataUrl);
      try {
        return await captureFrameFromVideo(video, timestampSeconds);
      } finally {
        releaseVideo(video);
      }
    },
    [captureFrameFromVideo]
  );

  const handleExportFrame = useCallback(
    // fallow-ignore-next-line complexity
    async (index: number) => {
      const item = mediaItems[index];
      const setting = frameExportSettings[index];
      const runtime = frameRuntime[index];
      if (!item || !setting?.enabled || !runtime?.durationSeconds) {
        throw new Error('Frame metadata is not ready.');
      }
      const timestampSeconds = clampFrameSecond(setting.timestampSeconds, runtime.durationSeconds);
      setFrameRuntime(previous => ({
        ...previous,
        [index]: { ...previous[index], status: 'exporting', error: undefined },
      }));
      try {
        const response = runtime.dataUrl
          ? { dataUrl: runtime.dataUrl }
          : ((await browser.runtime.sendMessage({
              type: 'FETCH_VIDEO_BLOB',
              url: item.url,
            })) as VideoBlobResponse);
        const dataUrl = getVideoBlobDataUrl(response);
        let result = await captureFrameFromDataUrl(dataUrl, timestampSeconds);
        if (Either.isLeft(result) && result.left.reason === 'timeout') {
          result = await captureFrameFromDataUrl(dataUrl, timestampSeconds);
        }
        if (Either.isLeft(result)) {
          throw new Error(frameExportErrorMessage(result.left.reason));
        }
        downloadBlobAsFile(result.right, frameFilename(item.filenameHint, timestampSeconds));
        const recorded = (await browser.runtime.sendMessage({
          type: 'RECORD_FRAME_EXPORT',
          sourceUrl: fetchedUrl || url,
          item: {
            itemIndex: item.itemIndex ?? item.index,
            ...(item.mediaId ? { mediaId: item.mediaId } : {}),
            url: item.url,
            filenameHint: item.filenameHint,
            mediaType: 'video',
            frameTimestampSeconds: timestampSeconds,
          },
        })) as { error?: string };
        setFrameRuntime(previous => ({
          ...previous,
          [index]: {
            ...previous[index],
            status: 'ready',
            ...(recorded.error ? { warning: recorded.error } : {}),
          },
        }));
      } catch (error) {
        const message = String(error).replace(/^Error: /, '');
        setFrameRuntime(previous => ({
          ...previous,
          [index]: { ...previous[index], status: 'failed', error: message },
        }));
        throw error;
      }
    },
    [captureFrameFromDataUrl, fetchedUrl, frameExportSettings, frameRuntime, mediaItems, url]
  );

  // fallow-ignore-next-line complexity
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
      const frameIndexes = selected
        .filter(item => item.type === 'video' && frameExportSettings[item.index]?.enabled)
        .map(item => item.index);
      const frameResults = await runFrameExportBatch(frameIndexes, handleExportFrame);
      const standardItems = selected.filter(item => !frameIndexes.includes(item.index));

      let directSuccessful = 0;
      let directFailures = 0;
      if (standardItems.length > 0) {
        const res = (await browser.runtime.sendMessage({
          type: 'DOWNLOAD_MEDIA',
          sourceUrl: fetchedUrl || url,
          items: standardItems.map(item => ({
            itemIndex: item.itemIndex ?? item.index,
            ...(item.mediaId ? { mediaId: item.mediaId } : {}),
            url: item.url,
            filenameHint: item.filenameHint,
            mediaType: item.type === 'video' ? 'video' : 'image',
          })),
        })) as DownloadMediaResponse;

        directSuccessful =
          res?.acceptedItemIndexes?.length ?? (res?.error ? 0 : standardItems.length);
        directFailures = res?.failures?.length ?? (res?.error ? standardItems.length : 0);
        if (res?.acceptedItemIndexes?.length)
          setMediaItems(previous =>
            previous.map(item =>
              res.acceptedItemIndexes!.includes(item.itemIndex ?? item.index)
                ? {
                    ...item,
                    history: {
                      downloaded: true,
                      count: (item.history?.count ?? 0) + 1,
                      latestDownloadedAt: Date.now(),
                    },
                  }
                : item
            )
          );
      }

      const failedFrames = frameResults.filter(result => result.error).length;
      const failures = directFailures + failedFrames;
      const successful = directSuccessful + frameResults.length - failedFrames;
      setMessage(
        failures
          ? `${successful} downloaded, ${failures} failed. Retry the failed items.`
          : `Downloaded ${successful} item${successful !== 1 ? 's' : ''} successfully.`
      );
      setStatus(failures ? 'error' : 'done');
    } catch (err) {
      setMessage(String(err));
      setStatus('error');
    }
  }, [fetchedUrl, frameExportSettings, handleExportFrame, mediaItems, url]);

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
  const handleVideoMetadata = useCallback(
    (index: number, durationSeconds: number) => setFrameDuration(index, durationSeconds),
    [setFrameDuration]
  );

  const loadHistory = useCallback(async () => {
    const response = (await browser.runtime.sendMessage({ type: 'GET_DOWNLOAD_HISTORY' })) as {
      entries?: HistoryEntry[];
      error?: string;
    };
    if (response.error) {
      setMessage(response.error);
      return;
    }
    setHistoryEntries(response.entries ?? []);
  }, []);

  const openHistory = useCallback(() => {
    setShowHistory(true);
    void loadHistory();
  }, [loadHistory]);
  const redownloadHistory = useCallback(
    // fallow-ignore-next-line complexity
    async (entryId: string) => {
      setHistoryBusy(entryId);
      const response = (await browser.runtime.sendMessage({
        type: 'REDOWNLOAD_HISTORY_ENTRY',
        entryId,
      })) as {
        error?: string;
        frame?: {
          itemIndex: number;
          mediaId?: string;
          url: string;
          filenameHint: string;
          timestampSeconds: number;
          sourceUrl: string;
        };
      };
      if (response.frame) {
        try {
          const videoResponse = (await browser.runtime.sendMessage({
            type: 'FETCH_VIDEO_BLOB',
            url: response.frame.url,
          })) as VideoBlobResponse;
          const dataUrl = getVideoBlobDataUrl(videoResponse);
          const duration = await getVideoDuration(dataUrl);
          const timestampSeconds = clampFrameSecond(response.frame.timestampSeconds, duration);
          let result = await captureFrameFromDataUrl(dataUrl, timestampSeconds);
          if (Either.isLeft(result) && result.left.reason === 'timeout') {
            result = await captureFrameFromDataUrl(dataUrl, timestampSeconds);
          }
          if (Either.isLeft(result)) throw new Error(frameExportErrorMessage(result.left.reason));
          downloadBlobAsFile(
            result.right,
            frameFilename(response.frame.filenameHint, timestampSeconds)
          );
          const recorded = (await browser.runtime.sendMessage({
            type: 'RECORD_FRAME_EXPORT',
            sourceUrl: response.frame.sourceUrl,
            item: {
              itemIndex: response.frame.itemIndex,
              ...(response.frame.mediaId ? { mediaId: response.frame.mediaId } : {}),
              url: response.frame.url,
              filenameHint: response.frame.filenameHint,
              mediaType: 'video',
              frameTimestampSeconds: timestampSeconds,
            },
          })) as { error?: string };
          const adjustment =
            timestampSeconds === response.frame.timestampSeconds
              ? ''
              : ` Timestamp adjusted to ${formatFrameTimestamp(timestampSeconds)}.`;
          setMessage(`${recorded.error ?? 'Frame download started.'}${adjustment}`);
        } catch (error) {
          setMessage(String(error).replace(/^Error: /, ''));
        }
      } else {
        setMessage(response.error ?? 'Download started.');
      }
      setHistoryBusy(null);
      if (!response.error) void loadHistory();
    },
    [captureFrameFromDataUrl, loadHistory]
  );
  const removeHistoryEntry = useCallback(async (entryId: string) => {
    const response = (await browser.runtime.sendMessage({
      type: 'DELETE_HISTORY_ENTRY',
      entryId,
    })) as { entries?: HistoryEntry[]; error?: string };
    if (response.error) setMessage(response.error);
    else setHistoryEntries(response.entries ?? []);
  }, []);
  const clearDownloadHistory = useCallback(async () => {
    if (!window.confirm('Clear all download history?')) return;
    const response = (await browser.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_HISTORY' })) as {
      error?: string;
    };
    if (response.error) setMessage(response.error);
    else setHistoryEntries([]);
  }, []);

  const {
    workspaceMode,
    workspaceExists,
    confirmReplace,
    setConfirmReplace,
    handleOpenWorkspace,
    handleReplaceWorkspace,
    hasTransferableSession,
    fetchIntent,
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
    frameExportSettings,
    setFrameExportSettings,
    setAutoDetected,
  });

  useEffect(() => {
    if (fetchIntent > 0) void handleFetchRef.current();
  }, [fetchIntent]);

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
        <div className="history-nav" aria-label="Popup view">
          <button
            className="workspace-secondary"
            type="button"
            onClick={() => setShowHistory(false)}
            aria-pressed={!showHistory}
          >
            Results
          </button>
          <button
            className="workspace-secondary"
            type="button"
            onClick={openHistory}
            aria-pressed={showHistory}
          >
            History
          </button>
        </div>
        {showHistory ? (
          <HistoryView
            entries={historyEntries}
            busyId={historyBusy}
            onRedownload={redownloadHistory}
            onRemove={removeHistoryEntry}
            onClear={clearDownloadHistory}
          />
        ) : (
          <>
            <div className="ext-section">
              <div className="field-label">Source URL</div>
              <input
                className={`url-input${autoDetected ? ' detected' : ''}`}
                type="url"
                placeholder="Paste an Instagram URL…"
                value={url}
                onChange={e => handleUrlChange(e.currentTarget.value)}
                onBlur={() => setUrl(current => canonicalizeInstagramUrl(current)?.url ?? current)}
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
              frameExportSettings={frameExportSettings}
              frameRuntime={frameRuntime}
              onPreviewError={handlePreviewError}
              onToggle={toggleItem}
              onToggleAll={toggleAll}
              onToggleExportFrame={toggleExportFrame}
              onChangeFrameTimestamp={changeFrameTimestamp}
              onRetryFrameMetadata={loadFrameMetadata}
              onRetryFrameExport={index => void handleExportFrame(index)}
              onVideoRef={handleVideoRef}
              onVideoMetadata={handleVideoMetadata}
              onIntrinsicDimensions={handleIntrinsicDimensions}
            />

            <div className="ext-section">
              <button
                className="btn"
                onClick={handleDownload}
                disabled={selectedCount === 0 || isBusy}
              >
                {renderDownloadButtonLabel(status, selectedCount)}
              </button>
            </div>
          </>
        )}
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

function HistoryView({
  entries,
  busyId,
  onRedownload,
  onRemove,
  onClear,
}: {
  entries: HistoryEntry[];
  busyId: string | null;
  onRedownload: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (!entries.length)
    return (
      <div className="ext-section media-empty">
        No downloads recorded yet. Only future accepted downloads are recorded.
      </div>
    );
  return (
    <section className="history-view" aria-label="Download history">
      <div className="history-heading">
        <div>
          <span className="history-eyebrow">Download history</span>
          <h2>
            {entries.length} saved download{entries.length === 1 ? '' : 's'}
          </h2>
        </div>
        <button className="history-clear" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="history-list">
        {entries.map(entry => (
          <article className="history-entry" key={entry.id}>
            <div className="history-entry-topline">
              <span className={`item-type-badge ${entry.mediaType}`}>{entry.mediaType}</span>
              <span className="history-item-number">Item {entry.itemIndex + 1}</span>
              <time
                title={new Date(entry.downloadedAt).toLocaleString()}
                dateTime={new Date(entry.downloadedAt).toISOString()}
              >
                {relativeHistoryTime(entry.downloadedAt)}
              </time>
            </div>
            <span className="history-filename" title={entry.filenameHint}>
              {entry.filenameHint}
            </span>
            <div className="history-entry-footer">
              <a
                className="history-source-link"
                href={entry.sourceUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open source for item ${entry.itemIndex + 1}`}
                title={entry.sourceUrl}
              >
                Open source ↗
              </a>
              <button
                className="history-redownload"
                type="button"
                disabled={busyId === entry.id}
                onClick={() => onRedownload(entry.id)}
              >
                {busyId === entry.id ? 'Starting…' : 'Re-download'}
              </button>
              <button
                className="history-remove"
                type="button"
                onClick={() => onRemove(entry.id)}
                aria-label={`Remove item ${entry.itemIndex + 1} from history`}
                title="Remove from history"
              >
                ×
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function relativeHistoryTime(downloadedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - downloadedAt) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
  frameExportSettings,
  frameRuntime,
  onPreviewError,
  onToggle,
  onToggleAll,
  onToggleExportFrame,
  onChangeFrameTimestamp,
  onRetryFrameMetadata,
  onRetryFrameExport,
  onVideoRef,
  onVideoMetadata,
  onIntrinsicDimensions,
}: {
  mediaItems: MediaItem[];
  workspaceMode: boolean;
  intrinsicDimensions: Record<number, { width: number; height: number }>;
  allSelected: boolean;
  fallbackLoading: Set<number>;
  fallbackFailed: Set<number>;
  frameExportSettings: Record<number, FrameExportSetting>;
  frameRuntime: Record<number, FrameRuntime>;
  onPreviewError: (item: MediaItem) => void;
  onToggle: (index: number) => void;
  onToggleAll: () => void;
  onToggleExportFrame: (index: number) => void;
  onChangeFrameTimestamp: (index: number, timestampSeconds: number) => void;
  onRetryFrameMetadata: (index: number) => void;
  onRetryFrameExport: (index: number) => void;
  onVideoRef: (index: number, el: HTMLVideoElement | null) => void;
  onVideoMetadata: (index: number, durationSeconds: number) => void;
  onIntrinsicDimensions: (item: MediaItem, width: number, height: number) => void;
}) {
  const masonryRef = useRef<HTMLDivElement>(null);
  const [masonryWidth, setMasonryWidth] = useState(0);
  const columnCount = Math.max(1, Math.floor((masonryWidth + 12) / 232));
  const masonryColumns = useMemo(() => {
    const columnWidth = Math.max(220, (masonryWidth - (columnCount - 1) * 12) / columnCount);
    return distributeMasonryItems(mediaItems, workspaceMode ? columnCount : 1, item => {
      const intrinsic = intrinsicDimensions[item.index];
      const ratio = resolveMediaRatio(item.width, item.height, intrinsic?.width, intrinsic?.height);
      return columnWidth / ratio + 104;
    });
  }, [columnCount, intrinsicDimensions, masonryWidth, mediaItems, workspaceMode]);

  useEffect(() => {
    const element = masonryRef.current;
    if (!workspaceMode || !element || typeof ResizeObserver === 'undefined') return;
    setMasonryWidth(Math.round(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(entries => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      setMasonryWidth(previous => (previous === width ? previous : width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [workspaceMode]);

  const renderItem = (item: MediaItem) => (
    <MediaItemRow
      key={item.index}
      item={item}
      workspaceMode={workspaceMode}
      intrinsicDimensions={intrinsicDimensions[item.index]}
      fallbackLoading={fallbackLoading.has(item.index)}
      fallbackFailed={fallbackFailed.has(item.index)}
      onError={() => onPreviewError(item)}
      onToggle={() => onToggle(item.index)}
      frameSetting={frameExportSettings[item.index]}
      frameRuntime={frameRuntime[item.index]}
      onToggleExportFrame={() => onToggleExportFrame(item.index)}
      onChangeFrameTimestamp={timestampSeconds =>
        onChangeFrameTimestamp(item.index, timestampSeconds)
      }
      onRetryFrameMetadata={() => onRetryFrameMetadata(item.index)}
      onRetryFrameExport={() => onRetryFrameExport(item.index)}
      onVideoRef={el => onVideoRef(item.index, el)}
      onVideoMetadata={durationSeconds => onVideoMetadata(item.index, durationSeconds)}
      onIntrinsicDimensions={(width, height) => onIntrinsicDimensions(item, width, height)}
    />
  );

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

      <div ref={masonryRef} className={`media-list${workspaceMode ? ' workspace-media-list' : ''}`}>
        {mediaItems.length === 0 ? (
          <p className="media-empty">No media yet.</p>
        ) : workspaceMode ? (
          masonryColumns.map((column, index) => (
            <div className="workspace-masonry-column" key={index}>
              {column.map(renderItem)}
            </div>
          ))
        ) : (
          mediaItems.map(renderItem)
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

function releaseVideo(video: HTMLVideoElement) {
  video.removeAttribute('src');
  video.load();
}

function getVideoDuration(dataUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = createExportVideo(dataUrl);
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
      window.clearTimeout(timeout);
      releaseVideo(video);
    };
    const onLoadedMetadata = () => {
      const duration = video.duration;
      cleanup();
      if (maximumFrameSecond(duration) === undefined) reject(new Error('duration unavailable'));
      else resolve(duration);
    };
    const onError = () => {
      cleanup();
      reject(new Error('video metadata unavailable'));
    };
    const timeout = window.setTimeout(onError, 5_000);
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
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

interface MediaItemRowProps {
  item: MediaItem;
  workspaceMode: boolean;
  intrinsicDimensions?: { width: number; height: number };
  fallbackLoading: boolean;
  fallbackFailed: boolean;
  onError: () => void;
  onToggle: () => void;
  frameSetting?: FrameExportSetting;
  frameRuntime?: FrameRuntime;
  onToggleExportFrame: () => void;
  onChangeFrameTimestamp: (timestampSeconds: number) => void;
  onRetryFrameMetadata: () => void;
  onRetryFrameExport: () => void;
  onVideoRef: (el: HTMLVideoElement | null) => void;
  onVideoMetadata: (durationSeconds: number) => void;
  onIntrinsicDimensions: (width: number, height: number) => void;
}

function MediaPreview({
  item,
  workspaceMode,
  intrinsicDimensions,
  fallbackLoading,
  fallbackFailed,
  onError,
  onVideoRef,
  onVideoMetadata,
  onIntrinsicDimensions,
}: Omit<
  MediaItemRowProps,
  | 'onToggle'
  | 'frameSetting'
  | 'frameRuntime'
  | 'onToggleExportFrame'
  | 'onChangeFrameTimestamp'
  | 'onRetryFrameMetadata'
  | 'onRetryFrameExport'
>) {
  const ratio = resolveMediaRatio(
    item.width,
    item.height,
    intrinsicDimensions?.width,
    intrinsicDimensions?.height
  );
  const previewStyle = workspaceMode ? ({ '--media-ratio': ratio } as CSSProperties) : undefined;

  return (
    <div className="media-thumb" style={previewStyle}>
      {item.type === 'video' ? (
        <VideoPreview
          item={item}
          onVideoRef={onVideoRef}
          onVideoMetadata={onVideoMetadata}
          onIntrinsicDimensions={onIntrinsicDimensions}
        />
      ) : (
        <ImagePreview
          item={item}
          fallbackFailed={fallbackFailed}
          onError={onError}
          onIntrinsicDimensions={onIntrinsicDimensions}
        />
      )}
      {fallbackLoading && !item.previewUrl && <span className="thumb-loading">···</span>}
    </div>
  );
}

function VideoPreview({
  item,
  onVideoRef,
  onVideoMetadata,
  onIntrinsicDimensions,
}: Pick<MediaItemRowProps, 'item' | 'onVideoRef' | 'onVideoMetadata' | 'onIntrinsicDimensions'>) {
  return (
    <>
      <video
        src={item.url}
        muted
        playsInline
        ref={onVideoRef}
        onLoadedMetadata={event => {
          onIntrinsicDimensions(event.currentTarget.videoWidth, event.currentTarget.videoHeight);
          onVideoMetadata(event.currentTarget.duration);
        }}
      />
      <div className="play-overlay">
        <div className="play-triangle" />
      </div>
    </>
  );
}

function ImagePreview({
  item,
  fallbackFailed,
  onError,
  onIntrinsicDimensions,
}: Pick<MediaItemRowProps, 'item' | 'fallbackFailed' | 'onError' | 'onIntrinsicDimensions'>) {
  if (fallbackFailed) {
    return (
      <div className="thumb-placeholder">
        <span className="thumb-icon">◻</span>
      </div>
    );
  }

  return (
    <img
      src={item.previewUrl ?? item.url}
      alt="Preview"
      onLoad={event =>
        onIntrinsicDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
      }
      onError={onError}
    />
  );
}

// fallow-ignore-next-line complexity
function MediaControls({
  item,
  frameSetting,
  frameRuntime,
  onToggle,
  onToggleExportFrame,
  onChangeFrameTimestamp,
  onRetryFrameMetadata,
  onRetryFrameExport,
}: Pick<
  MediaItemRowProps,
  | 'item'
  | 'frameSetting'
  | 'frameRuntime'
  | 'onToggle'
  | 'onToggleExportFrame'
  | 'onChangeFrameTimestamp'
  | 'onRetryFrameMetadata'
  | 'onRetryFrameExport'
>) {
  const duration = frameRuntime?.durationSeconds;
  const maximum = duration === undefined ? undefined : maximumFrameSecond(duration);
  const timestampSeconds = frameSetting?.timestampSeconds ?? 0;
  return (
    <div className="media-controls">
      {item.type === 'video' && (
        <div className="frame-export-control" onClick={event => event.stopPropagation()}>
          <label className="frame-toggle" title="Export a JPEG frame on download">
            <input
              type="checkbox"
              checked={frameSetting?.enabled ?? false}
              onChange={onToggleExportFrame}
              className="frame-toggle-checkbox"
            />
            Frame
          </label>
          {frameSetting?.enabled && (
            <div className="frame-timestamp-row">
              <input
                type="range"
                min="0"
                max={maximum ?? 0}
                step="1"
                value={timestampSeconds}
                disabled={frameRuntime?.status !== 'ready' || maximum === undefined}
                aria-label={`Frame timestamp for item ${String(item.index + 1).padStart(2, '0')}`}
                aria-valuetext={frameTimestampAriaValue(timestampSeconds)}
                onChange={event => onChangeFrameTimestamp(Number(event.currentTarget.value))}
              />
              <output>{formatFrameTimestamp(timestampSeconds)}</output>
              {frameRuntime?.status === 'loading' && <span>Loading…</span>}
              {frameRuntime?.status === 'failed' && (
                <button
                  type="button"
                  className="frame-retry"
                  onClick={frameRuntime.durationSeconds ? onRetryFrameExport : onRetryFrameMetadata}
                >
                  Retry
                </button>
              )}
              {frameRuntime?.error && <span className="frame-error">{frameRuntime.error}</span>}
              {frameRuntime?.warning && <span>{frameRuntime.warning}</span>}
            </div>
          )}
        </div>
      )}
      <input
        className="item-checkbox"
        type="checkbox"
        checked={item.selected}
        onChange={onToggle}
        onClick={event => event.stopPropagation()}
      />
    </div>
  );
}

function MediaItemRow(props: MediaItemRowProps) {
  const {
    item,
    workspaceMode,
    intrinsicDimensions,
    fallbackLoading,
    fallbackFailed,
    onError,
    onToggle,
    frameSetting,
    frameRuntime,
    onToggleExportFrame,
    onChangeFrameTimestamp,
    onRetryFrameMetadata,
    onRetryFrameExport,
    onVideoRef,
    onVideoMetadata,
    onIntrinsicDimensions,
  } = props;
  const num = String(item.index + 1).padStart(2, '0');

  return (
    <div className={`media-item${item.selected ? ' selected' : ''}`} onClick={onToggle}>
      <span className="item-number">{num}</span>

      <MediaPreview
        item={item}
        workspaceMode={workspaceMode}
        intrinsicDimensions={intrinsicDimensions}
        fallbackLoading={fallbackLoading}
        fallbackFailed={fallbackFailed}
        onError={onError}
        onVideoRef={onVideoRef}
        onVideoMetadata={onVideoMetadata}
        onIntrinsicDimensions={onIntrinsicDimensions}
      />

      <div className="item-info">
        <span className={`item-type-badge ${item.type}`}>{item.type}</span>
        {item.history?.downloaded && (
          <span
            className="item-type-badge"
            aria-label={`Downloaded ${new Date(item.history.latestDownloadedAt ?? Date.now()).toLocaleString()}`}
          >
            Downloaded
          </span>
        )}
        <span className="item-filename">{item.filenameHint}</span>
      </div>

      <MediaControls
        item={item}
        frameSetting={frameSetting}
        frameRuntime={frameRuntime}
        onToggle={onToggle}
        onToggleExportFrame={onToggleExportFrame}
        onChangeFrameTimestamp={onChangeFrameTimestamp}
        onRetryFrameMetadata={onRetryFrameMetadata}
        onRetryFrameExport={onRetryFrameExport}
      />
    </div>
  );
}
