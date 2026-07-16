import { useState, useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Effect, Either } from 'effect';
import './styles.css';
import { browser } from './lib/browser';
import { captureFrameFromVideoEffect } from './effect/frame-extraction';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  createRequestId,
  type DownloadOperation,
  type DownloadOperationResult,
} from './download/contracts';
import { type AttemptEntry, type AttemptOperation } from './download/attempt';
import { useDownloadAttempt } from './download/use-download-attempt';
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
import {
  findWorkspaceTab,
  isWorkspaceReportedBusy,
  openWorkspace,
  replaceWorkspace,
} from './workspace/coordinator';
import { isPositiveFinitePair, resolveMediaRatio } from './workspace/media-ratio';
import { distributeMasonryItems } from './workspace/masonry';
import { runSilentVideoBatch, type ReencodeCandidate } from './silent-video/batch';

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
const SILENT_PHASE_LABELS: Readonly<Record<string, string>> = {
  queued: 'Waiting to inspect video',
  inspecting: 'Inspecting video',
  processing: 'Removing audio',
  validating: 'Validating silent video',
  downloading: 'Download started',
};

function silentProgressMessage(entries: readonly AttemptEntry[] | undefined): string | undefined {
  const active = entries?.flatMap(entry =>
    entry.operation.mode === 'silent' && entry.outcome.status === 'pending' ? [entry.outcome] : []
  );
  const progressState = ['processing', 'validating', 'inspecting', 'downloading', 'queued'].flatMap(
    phase => {
      const outcome = active?.find(candidate => candidate.phase === phase);
      return outcome ? [outcome] : [];
    }
  )[0];
  if (!progressState?.phase) return undefined;
  const label = SILENT_PHASE_LABELS[progressState.phase];
  if (!label) return undefined;
  if (progressState.phase === 'queued') return `${label}…`;
  if (progressState.phase === 'downloading') return label;
  return `${label}… ${Math.round((progressState.progress ?? 0) * 100)}%`;
}

type FrameRuntime = {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'exporting';
  durationSeconds?: number;
  dataUrl?: string;
  error?: string;
  warning?: string;
};
type HistoryEntry = {
  id: string;
  sourceUrl: string;
  sourceKind: string;
  itemIndex: number;
  mediaType: string;
  filenameHint: string;
  exportMode?: 'direct' | 'frame' | 'silent';
  frameTimestampSeconds?: number;
  downloadedAt: number;
};

// fallow-ignore-next-line complexity
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
  const [removeAudioIndexes, setRemoveAudioIndexes] = useState<Set<number>>(new Set());
  const [fallbackLoading, setFallbackLoading] = useState<Set<number>>(new Set());
  const [fallbackFailed, setFallbackFailed] = useState<Set<number>>(new Set());
  const [intrinsicDimensions, setIntrinsicDimensions] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const [autoDetected, setAutoDetected] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [reencodeChoice, setReencodeChoice] = useState<{
    candidates: readonly ReencodeCandidate[];
    resolve: (approved: boolean) => void;
  }>();
  const videoRefs = useRef<Record<number, HTMLVideoElement | null>>({});
  const resultsGeneration = useRef(0);
  const pendingFrameDefaults = useRef(new Set<number>());
  const clearAttemptRef = useRef<() => void>(() => {});

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
    onSuccess: () => clearAttemptRef.current(),
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
      if (enabled) {
        setRemoveAudioIndexes(previous => {
          const next = new Set(previous);
          next.delete(index);
          return next;
        });
        void loadFrameMetadata(index);
      }
    },
    [frameExportSettings, loadFrameMetadata]
  );

  const toggleRemoveAudio = useCallback((index: number) => {
    setRemoveAudioIndexes(previous => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    setFrameExportSettings(previous => {
      const setting = previous[index];
      return setting ? { ...previous, [index]: { ...setting, enabled: false } } : previous;
    });
  }, []);

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

  const executeFrameAttempt = useCallback(
    // fallow-ignore-next-line complexity
    async (operation: AttemptOperation): Promise<DownloadOperationResult> => {
      const runtime = frameRuntime[operation.displayIndex];
      if (!runtime?.durationSeconds || operation.frameTimestampSeconds === undefined)
        return DownloadFailedResult.make({
          requestId: operation.requestId,
          status: 'failed',
          reason: 'Frame metadata is not ready.',
        });
      setFrameRuntime(previous => ({
        ...previous,
        [operation.displayIndex]: {
          ...previous[operation.displayIndex],
          status: 'exporting',
          error: undefined,
        },
      }));
      try {
        const response = runtime.dataUrl
          ? { dataUrl: runtime.dataUrl }
          : ((await browser.runtime.sendMessage({
              type: 'FETCH_VIDEO_BLOB',
              url: operation.url,
            })) as VideoBlobResponse);
        const dataUrl = getVideoBlobDataUrl(response);
        let captured = await captureFrameFromDataUrl(dataUrl, operation.frameTimestampSeconds);
        if (Either.isLeft(captured) && captured.left.reason === 'timeout')
          captured = await captureFrameFromDataUrl(dataUrl, operation.frameTimestampSeconds);
        if (Either.isLeft(captured))
          return DownloadFailedResult.make({
            requestId: operation.requestId,
            status: 'failed',
            reason: frameExportErrorMessage(captured.left.reason),
          });
        downloadBlobAsFile(captured.right, operation.filename);
        const recorded = (await browser.runtime.sendMessage({
          type: 'RECORD_FRAME_EXPORT',
          sourceUrl: fetchedUrl || url,
          item: {
            itemIndex: operation.itemIndex,
            ...(operation.mediaId ? { mediaId: operation.mediaId } : {}),
            url: operation.url,
            filename: operation.filename,
            mediaType: 'video',
            frameTimestampSeconds: operation.frameTimestampSeconds,
          },
        })) as { error?: string };
        setFrameRuntime(previous => ({
          ...previous,
          [operation.displayIndex]: {
            ...previous[operation.displayIndex],
            status: 'ready',
            ...(recorded.error ? { warning: recorded.error } : {}),
          },
        }));
        return DownloadAcceptedResult.make({
          requestId: operation.requestId,
          status: 'accepted',
          ...(recorded.error ? { warning: recorded.error } : {}),
        });
      } catch {
        setFrameRuntime(previous => ({
          ...previous,
          [operation.displayIndex]: {
            ...previous[operation.displayIndex],
            status: 'failed',
            error: 'Frame export failed.',
          },
        }));
        return DownloadFailedResult.make({
          requestId: operation.requestId,
          status: 'failed',
          reason: 'Frame export failed.',
        });
      }
    },
    [captureFrameFromDataUrl, fetchedUrl, frameRuntime, url]
  );

  const executeDirect = useCallback(
    (operations: readonly DownloadOperation[]) =>
      browser.runtime.sendMessage({
        type: 'DOWNLOAD_MEDIA',
        sourceUrl: fetchedUrl || url,
        operations,
      }),
    [fetchedUrl, url]
  );

  const requestReencodeApproval = useCallback(
    (candidates: readonly ReencodeCandidate[]) =>
      new Promise<boolean>(resolve => setReencodeChoice({ candidates, resolve })),
    []
  );

  const settleReencodeChoice = useCallback((approved: boolean) => {
    setReencodeChoice(choice => {
      choice?.resolve(approved);
      return undefined;
    });
  }, []);

  const downloadAttempt = useDownloadAttempt({
    executeFrame: executeFrameAttempt,
    executeDirect,
    executeSilent: (operations, onProgress, onPreflightComplete, approvedRequestIds) =>
      runSilentVideoBatch(
        operations,
        requestReencodeApproval,
        onProgress,
        fetchedUrl || url,
        onPreflightComplete,
        approvedRequestIds
      ),
    onAccepted: operations =>
      setMediaItems(previous =>
        previous.map(item =>
          operations.some(operation => operation.displayIndex === item.index)
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
      ),
    onSettled: next => {
      const summary = next.entries.reduce(
        (counts, entry) => ({
          pending: counts.pending + Number(entry.outcome.status === 'pending'),
          succeeded: counts.succeeded + Number(entry.outcome.status === 'accepted'),
          failed: counts.failed + Number(entry.outcome.status === 'failed'),
          skipped: counts.skipped + Number(entry.outcome.status === 'skipped'),
        }),
        { pending: 0, succeeded: 0, failed: 0, skipped: 0 }
      );
      if (summary.pending > 0) {
        setStatus('downloading');
        setMessage('Downloading…');
        return;
      }
      setStatus(summary.failed ? 'error' : 'done');
      setMessage(
        summary.failed
          ? `${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.skipped} skipped.`
          : summary.skipped > 0
            ? `${summary.succeeded} succeeded, ${summary.skipped} skipped.`
            : `${summary.succeeded} item${summary.succeeded === 1 ? '' : 's'} succeeded.`
      );
    },
  });
  clearAttemptRef.current = downloadAttempt.clear;

  useEffect(() => {
    const progressMessage = silentProgressMessage(downloadAttempt.attempt?.entries);
    if (!progressMessage) return;
    setMessage(progressMessage);
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [downloadAttempt.attempt]);

  const handleExportFrame = useCallback(
    async (index: number) => {
      const item = mediaItems[index];
      const setting = frameExportSettings[index];
      const runtime = frameRuntime[index];
      if (!item || !setting?.enabled || !runtime?.durationSeconds) return;
      const timestampSeconds = clampFrameSecond(setting.timestampSeconds, runtime.durationSeconds);
      await executeFrameAttempt({
        requestId: createRequestId(),
        itemIndex: item.itemIndex ?? item.index,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        filename: frameFilename(item.filenameHint, timestampSeconds),
        mediaType: 'video',
        mode: 'frame',
        displayIndex: index,
        frameTimestampSeconds: timestampSeconds,
      });
    },
    [executeFrameAttempt, frameExportSettings, frameRuntime, mediaItems]
  );

  const handleDownload = useCallback(async () => {
    const selected = mediaItems.filter(item => item.selected);
    if (selected.length === 0) {
      setMessage('No items selected.');
      setStatus('error');
      return;
    }
    // fallow-ignore-next-line complexity
    const operations = selected.map<AttemptOperation>(item => {
      const setting = frameExportSettings[item.index];
      const duration = frameRuntime[item.index]?.durationSeconds;
      const removeAudio = item.type === 'video' && removeAudioIndexes.has(item.index);
      const exportFrame = item.type === 'video' && setting?.enabled && !removeAudio;
      const timestampSeconds = exportFrame
        ? clampFrameSecond(setting.timestampSeconds, duration ?? setting.timestampSeconds + 1)
        : undefined;
      return {
        requestId: createRequestId(),
        itemIndex: item.itemIndex ?? item.index,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        filename: removeAudio
          ? `${item.filenameHint}_${item.index + 1}_silent.mp4`
          : exportFrame
            ? frameFilename(item.filenameHint, timestampSeconds ?? 0)
            : `${item.filenameHint}_${item.index + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
        mediaType: item.type === 'video' ? 'video' : 'image',
        mode: removeAudio ? 'silent' : exportFrame ? 'frame' : 'direct',
        displayIndex: item.index,
        ...(timestampSeconds !== undefined ? { frameTimestampSeconds: timestampSeconds } : {}),
      };
    });
    if (!initialWorkspaceMode && operations.some(operation => operation.mode === 'silent')) {
      const createdAt = Date.now();
      const snapshot = {
        version: 3 as const,
        createdAt,
        expiresAt: createdAt + 60_000,
        url,
        fetchedUrl,
        status: 'done' as const,
        message,
        mediaItems,
        frameExportSettings,
        removeAudioIndexes: [...removeAudioIndexes],
        autoStartDownload: true,
      };
      const existing = await findWorkspaceTab();
      if (existing) {
        if (await isWorkspaceReportedBusy()) {
          await openWorkspace(snapshot);
          setMessage('The workspace is busy. Finish its active batch before replacing it.');
          return;
        }
        if (!window.confirm('Replace the current workspace session and start this batch?')) return;
        await replaceWorkspace(snapshot);
      } else {
        await openWorkspace(snapshot);
      }
      setMessage('Silent batch moved to the GramGrab workspace.');
      return;
    }
    setStatus('downloading');
    setMessage(`Starting ${operations.length} item${operations.length === 1 ? '' : 's'}…`);
    await downloadAttempt.start(operations);
  }, [
    downloadAttempt,
    fetchedUrl,
    frameExportSettings,
    frameRuntime,
    initialWorkspaceMode,
    mediaItems,
    message,
    removeAudioIndexes,
    url,
  ]);

  const selectedCount = mediaItems.filter(m => m.selected).length;
  const allSelected = mediaItems.length > 0 && selectedCount === mediaItems.length;

  const toggleAll = useCallback(() => {
    const newSelected = !allSelected;
    setMediaItems(prev => prev.map(item => ({ ...item, selected: newSelected })));
  }, [allSelected]);

  const isBusy = isWorkspaceBusy(status) || downloadAttempt.busy;
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
        results?: { status: 'accepted' | 'failed'; reason?: string }[];
        frame?: {
          itemIndex: number;
          mediaId?: string;
          url: string;
          filenameHint: string;
          timestampSeconds: number;
          sourceUrl: string;
        };
        silent?: {
          itemIndex: number;
          mediaId?: string;
          url: string;
          filenameHint: string;
          sourceUrl: string;
        };
      };
      if (response.silent) {
        const createdAt = Date.now();
        const item = {
          index: 0,
          itemIndex: response.silent.itemIndex,
          ...(response.silent.mediaId ? { mediaId: response.silent.mediaId } : {}),
          type: 'video',
          url: response.silent.url,
          filenameHint: response.silent.filenameHint,
          selected: true,
        };
        const snapshot = {
          version: 3 as const,
          createdAt,
          expiresAt: createdAt + 60_000,
          url: response.silent.sourceUrl,
          fetchedUrl: response.silent.sourceUrl,
          status: 'done' as const,
          message: 'History item restored.',
          mediaItems: [item],
          frameExportSettings: {},
          removeAudioIndexes: [0],
          autoStartDownload: true,
        };
        const existing = await findWorkspaceTab();
        if (existing && (await isWorkspaceReportedBusy())) {
          await openWorkspace(snapshot);
          setMessage('The workspace is busy. Finish its active batch before replacing it.');
        } else if (
          !existing ||
          window.confirm('Replace the current workspace session and start this batch?')
        ) {
          if (existing) await replaceWorkspace(snapshot);
          else await openWorkspace(snapshot);
          setMessage('Silent download moved to the GramGrab workspace.');
        }
      } else if (response.frame) {
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
              filename: frameFilename(response.frame.filenameHint, timestampSeconds),
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
        const failed = response.results?.find(result => result.status === 'failed');
        setMessage(response.error ?? failed?.reason ?? 'Download started.');
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
    downloadIntent,
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
    removeAudioIndexes,
    setRemoveAudioIndexes,
    setAutoDetected,
  });

  useEffect(() => {
    if (fetchIntent > 0) void handleFetchRef.current();
  }, [fetchIntent]);

  useEffect(() => {
    if (downloadIntent > 0) void handleDownload();
  }, [downloadIntent, handleDownload]);

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
                disabled={isBusy}
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
              removeAudioIndexes={removeAudioIndexes}
              frameRuntime={frameRuntime}
              attempt={downloadAttempt.attempt}
              disabled={isBusy}
              onPreviewError={handlePreviewError}
              onToggle={toggleItem}
              onToggleAll={toggleAll}
              onToggleExportFrame={toggleExportFrame}
              onToggleRemoveAudio={toggleRemoveAudio}
              onChangeFrameTimestamp={changeFrameTimestamp}
              onRetryFrameMetadata={loadFrameMetadata}
              onRetryFrameExport={index => void handleExportFrame(index)}
              onVideoRef={handleVideoRef}
              onVideoMetadata={handleVideoMetadata}
              onIntrinsicDimensions={handleIntrinsicDimensions}
            />

            <div className="ext-section">
              {downloadAttempt.attempt && (
                <section
                  className="download-attempt-summary"
                  ref={downloadAttempt.summaryRef}
                  tabIndex={-1}
                  aria-live="polite"
                  aria-busy={downloadAttempt.busy}
                >
                  <strong>
                    {downloadAttempt.summary.succeeded} succeeded, {downloadAttempt.summary.failed}{' '}
                    failed, {downloadAttempt.summary.skipped} skipped
                  </strong>
                  {downloadAttempt.summary.warnings > 0 && (
                    <span> {downloadAttempt.summary.warnings} started with a history warning.</span>
                  )}
                  {downloadAttempt.retryable.length > 0 && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void downloadAttempt.retry()}
                      disabled={isBusy}
                    >
                      Retry {downloadAttempt.retryable.length} failed
                    </button>
                  )}
                  {downloadAttempt.attempt.retryCount > 0 && downloadAttempt.summary.failed > 0 && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void handleFetch()}
                      disabled={isBusy}
                    >
                      Fetch source again
                    </button>
                  )}
                </section>
              )}
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
      {reencodeChoice && (
        <ReencodeDialog candidates={reencodeChoice.candidates} onChoice={settleReencodeChoice} />
      )}
    </div>
  );
}

function ReencodeDialog({
  candidates,
  onChoice,
}: {
  candidates: readonly ReencodeCandidate[];
  onChoice: (approved: boolean) => void;
}) {
  return (
    <div className="quality-dialog-backdrop" onMouseDown={() => onChoice(false)}>
      <section
        className="quality-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quality-dialog-title"
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => event.key === 'Escape' && onChoice(false)}
      >
        <button
          type="button"
          className="quality-dialog-close"
          aria-label="Skip videos requiring re-encoding"
          onClick={() => onChoice(false)}
        >
          ×
        </button>
        <h2 id="quality-dialog-title">Some videos require re-encoding</h2>
        <p>Lossless packet copying is unavailable. Re-encoding may change video quality.</p>
        <ul>
          {candidates.map(candidate => (
            <li key={candidate.operation.requestId}>
              <video src={candidate.operation.url} muted preload="metadata" aria-hidden="true" />
              <span>Item {candidate.operation.displayIndex + 1}</span>
              <strong>{candidate.operation.filename}</strong>
              <small>{candidate.preflight.reason ?? candidate.preflight.videoCodec}</small>
            </li>
          ))}
        </ul>
        <div className="quality-dialog-actions">
          <button type="button" onClick={() => onChoice(false)}>
            Skip affected videos
          </button>
          <button type="button" onClick={() => onChoice(true)} autoFocus>
            Re-encode affected videos
          </button>
        </div>
      </section>
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
  removeAudioIndexes,
  frameRuntime,
  attempt,
  disabled,
  onPreviewError,
  onToggle,
  onToggleAll,
  onToggleExportFrame,
  onToggleRemoveAudio,
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
  removeAudioIndexes: Set<number>;
  frameRuntime: Record<number, FrameRuntime>;
  attempt: ReturnType<typeof useDownloadAttempt>['attempt'];
  disabled: boolean;
  onPreviewError: (item: MediaItem) => void;
  onToggle: (index: number) => void;
  onToggleAll: () => void;
  onToggleExportFrame: (index: number) => void;
  onToggleRemoveAudio: (index: number) => void;
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
      removeAudio={removeAudioIndexes.has(item.index)}
      frameRuntime={frameRuntime[item.index]}
      attemptEntry={attempt?.entries.find(entry => entry.operation.displayIndex === item.index)}
      disabled={disabled}
      onToggleExportFrame={() => onToggleExportFrame(item.index)}
      onToggleRemoveAudio={() => onToggleRemoveAudio(item.index)}
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
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              disabled={disabled}
            />
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
  removeAudio: boolean;
  frameRuntime?: FrameRuntime;
  onToggleExportFrame: () => void;
  onToggleRemoveAudio: () => void;
  onChangeFrameTimestamp: (timestampSeconds: number) => void;
  onRetryFrameMetadata: () => void;
  onRetryFrameExport: () => void;
  onVideoRef: (el: HTMLVideoElement | null) => void;
  onVideoMetadata: (durationSeconds: number) => void;
  onIntrinsicDimensions: (width: number, height: number) => void;
  disabled: boolean;
  attemptEntry?: AttemptEntry;
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
  | 'removeAudio'
  | 'frameRuntime'
  | 'onToggleExportFrame'
  | 'onToggleRemoveAudio'
  | 'onChangeFrameTimestamp'
  | 'onRetryFrameMetadata'
  | 'onRetryFrameExport'
  | 'disabled'
  | 'attemptEntry'
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
  removeAudio,
  frameRuntime,
  onToggle,
  onToggleExportFrame,
  onToggleRemoveAudio,
  onChangeFrameTimestamp,
  onRetryFrameMetadata,
  onRetryFrameExport,
  disabled,
  failureDescriptionId,
}: Pick<
  MediaItemRowProps,
  | 'item'
  | 'frameSetting'
  | 'removeAudio'
  | 'frameRuntime'
  | 'onToggle'
  | 'onToggleExportFrame'
  | 'onToggleRemoveAudio'
  | 'onChangeFrameTimestamp'
  | 'onRetryFrameMetadata'
  | 'onRetryFrameExport'
  | 'disabled'
> & { failureDescriptionId?: string }) {
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
              disabled={disabled}
              className="frame-toggle-checkbox"
            />
            Frame
          </label>
          <label className="frame-toggle" title="Download a silent MP4">
            <input
              type="checkbox"
              checked={removeAudio}
              onChange={onToggleRemoveAudio}
              disabled={disabled}
              className="frame-toggle-checkbox"
            />
            Remove audio
          </label>
          {frameSetting?.enabled && (
            <div className="frame-timestamp-row">
              <input
                type="range"
                min="0"
                max={maximum ?? 0}
                step="1"
                value={timestampSeconds}
                disabled={disabled || frameRuntime?.status !== 'ready' || maximum === undefined}
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
                  disabled={disabled}
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
        disabled={disabled}
        aria-describedby={failureDescriptionId}
      />
    </div>
  );
}

// fallow-ignore-next-line complexity
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
    removeAudio,
    frameRuntime,
    onToggleExportFrame,
    onToggleRemoveAudio,
    onChangeFrameTimestamp,
    onRetryFrameMetadata,
    onRetryFrameExport,
    onVideoRef,
    onVideoMetadata,
    onIntrinsicDimensions,
    disabled,
    attemptEntry,
  } = props;
  const num = String(item.index + 1).padStart(2, '0');

  return (
    <div
      className={`media-item${item.selected ? ' selected' : ''}`}
      onClick={() => !disabled && onToggle()}
    >
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
        {attemptEntry?.outcome.status === 'pending' && (
          <span className="download-item-status pending">
            {attemptEntry.outcome.phase
              ? `${attemptEntry.outcome.phase} ${Math.round((attemptEntry.outcome.progress ?? 0) * 100)}%`
              : attemptEntry.operation.mode === 'frame'
                ? 'Exporting…'
                : 'Starting…'}
          </span>
        )}
        {attemptEntry?.outcome.status === 'accepted' && (
          <span className="download-item-status accepted">
            {attemptEntry.operation.mode === 'frame' ? 'Frame exported' : 'Download started'}
          </span>
        )}
        {attemptEntry?.outcome.status === 'accepted' && attemptEntry.outcome.warning && (
          <span className="download-item-status warning">{attemptEntry.outcome.warning}</span>
        )}
        {attemptEntry?.outcome.status === 'failed' && (
          <span className="download-item-status failed" id={`download-result-${item.index}`}>
            Failed: {attemptEntry.outcome.reason}
          </span>
        )}
        {attemptEntry?.outcome.status === 'skipped' && (
          <span className="download-item-status skipped">
            Skipped: {attemptEntry.outcome.reason}
          </span>
        )}
      </div>

      <MediaControls
        item={item}
        frameSetting={frameSetting}
        removeAudio={removeAudio}
        frameRuntime={frameRuntime}
        onToggle={onToggle}
        onToggleExportFrame={onToggleExportFrame}
        onToggleRemoveAudio={onToggleRemoveAudio}
        onChangeFrameTimestamp={onChangeFrameTimestamp}
        onRetryFrameMetadata={onRetryFrameMetadata}
        onRetryFrameExport={onRetryFrameExport}
        disabled={disabled}
        failureDescriptionId={
          attemptEntry?.outcome.status === 'failed' ? `download-result-${item.index}` : undefined
        }
      />
    </div>
  );
}
