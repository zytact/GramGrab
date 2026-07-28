import { useState, useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import './styles.css';
import { browser } from './lib/browser';
import {
  createOperationId,
  createRequestId,
  DownloadFailedResult,
  type DownloadOperation,
  type DownloadOperationResult,
} from './download/contracts';
import type { OperationFailure, RecoveryAction } from './errors/contracts';
import { normalizeFrameFailure } from './errors/normalize';
import { FAILURE_PRESENTATION, WARNING_PRESENTATION } from './errors/presentation';
import { buildDiagnostics } from './errors/diagnostics';
import type { AttemptEntry, AttemptOperation, DownloadAttempt } from './download/attempt';
import { useDownloadAttempt } from './download/use-download-attempt';
import { ExportCandidate, planExportOperations } from './download/coordinator';
import {
  clampFrameSecond,
  defaultFrameSecond,
  frameFilename,
  frameTimestampAriaValue,
  formatFrameTimestamp,
  maximumFrameSecond,
  type FrameExportSetting,
} from './frame-export/timestamp';
import { executeFrameExport } from './frame-export/executor';
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
import { silentProgressMessage } from './silent-video/progress';

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
  creatorUsername?: string;
}

interface PreviewResponse {
  previewUrl?: string;
  error?: string;
}

type VideoBlobResponse = { dataUrl?: string; error?: string };

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';
type FrameRuntime = {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'exporting';
  durationSeconds?: number;
  dataUrl?: string;
  error?: string;
  warning?: string;
};
type HistoryEntry = {
  id: string;
  origin: { kind: 'source'; sourceUrl: string; sourceKind: string } | { kind: 'instants' };
  itemIndex: number;
  mediaType: string;
  filenameHint: string;
  exportMode?: 'direct' | 'frame' | 'silent';
  frameTimestampSeconds?: number;
  downloadedAt: number;
};

function exportCandidate(
  item: MediaItem,
  frameExportSettings: Record<number, FrameExportSetting>,
  frameRuntime: Record<number, FrameRuntime>,
  removeAudioIndexes: ReadonlySet<number>
): ExportCandidate {
  const setting = frameExportSettings[item.index];
  const durationSeconds = frameRuntime[item.index]?.durationSeconds;
  return ExportCandidate.make({
    index: item.index,
    itemIndex: item.itemIndex,
    mediaId: item.mediaId,
    type: item.type === 'video' ? 'video' : 'image',
    url: item.url,
    filenameHint: item.filenameHint,
    selected: item.selected,
    frameEnabled: setting?.enabled ?? false,
    frameTimestampSeconds: setting?.timestampSeconds ?? 0,
    frameDurationSeconds: durationSeconds,
    removeAudio: removeAudioIndexes.has(item.index),
  });
}

function diagnosticsForAttempt(
  current: DownloadAttempt | undefined,
  diagnosticFailure: OperationFailure | undefined,
  sourceUrl: string
): string {
  const entries = current?.entries ?? [];
  return buildDiagnostics({
    extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
    browser: { userAgent: navigator.userAgent },
    source: { url: sourceUrl },
    attempt: {
      entries: entries.map(entry => ({
        operationId: entry.operation.operationId,
        requestId: entry.operation.requestId,
        executionCount: entry.executionCount,
        manualRetryCount: entry.manualRetryCount,
      })),
    },
    items: entries.map(entry => ({
      operationId: entry.operation.operationId,
      requestId: entry.operation.requestId,
      temporaryMediaUrl: entry.operation.url,
      filename: entry.operation.filename,
      mediaType: entry.operation.mediaType,
      outcome: entry.outcome,
    })),
    ...(diagnosticFailure ? { batchFailure: diagnosticFailure } : {}),
    warnings: entries.flatMap(entry =>
      entry.outcome.status === 'started' && entry.outcome.warning ? [entry.outcome.warning] : []
    ),
  });
}

// fallow-ignore-next-line complexity
export default function Popup() {
  const initialWorkspaceMode =
    new URLSearchParams(window.location.search).get('surface') === 'workspace';
  const [url, setUrl] = useState(() =>
    initialWorkspaceMode ? (new URLSearchParams(window.location.search).get('source') ?? '') : ''
  );
  const [fetchedUrl, setFetchedUrl] = useState('');
  const [acquisition, setAcquisition] = useState<'source' | 'instants'>('source');
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
  const [sourceFailure, setSourceFailure] = useState<OperationFailure>();
  const [reencodeChoice, setReencodeChoice] = useState<{
    candidates: readonly ReencodeCandidate[];
    resolve: (approved: boolean) => void;
  }>();
  const [diagnosticsPreview, setDiagnosticsPreview] = useState<{
    json: string;
    trigger: HTMLButtonElement;
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
    acquisition,
    setFetchedUrl,
    setMediaItems: replaceMediaItems,
    setFrameExportSettings,
    setStatus,
    setMessage,
    onSuccess: () => {
      setSourceFailure(undefined);
      clearAttemptRef.current();
    },
    onFailure: setSourceFailure,
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

  const executeFrameAttempt = useCallback(
    async (operation: AttemptOperation): Promise<DownloadOperationResult> => {
      const runtime = frameRuntime[operation.displayIndex];
      if (!runtime?.durationSeconds || operation.frameTimestampSeconds === undefined)
        return DownloadFailedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'failed',
          failure: normalizeFrameFailure('no-duration'),
        });
      setFrameRuntime(previous => ({
        ...previous,
        [operation.displayIndex]: {
          ...previous[operation.displayIndex],
          status: 'exporting',
          error: undefined,
        },
      }));
      const result = await executeFrameExport(operation, fetchedUrl || url, {
        originKind: acquisition,
      });
      if (result.status === 'started') {
        setFrameRuntime(previous => ({
          ...previous,
          [operation.displayIndex]: {
            ...previous[operation.displayIndex],
            status: 'ready',
            ...(result.warning
              ? { warning: 'Frame downloaded, but history could not be saved.' }
              : {}),
          },
        }));
      } else {
        setFrameRuntime(previous => ({
          ...previous,
          [operation.displayIndex]: {
            ...previous[operation.displayIndex],
            status: 'failed',
            error: 'Frame export failed.',
          },
        }));
      }
      return result;
    },
    [acquisition, fetchedUrl, frameRuntime, url]
  );

  const executeDirect = useCallback(
    (operations: readonly DownloadOperation[]) =>
      browser.runtime.sendMessage({
        type: 'DOWNLOAD_MEDIA',
        ...(acquisition === 'source' ? { sourceUrl: fetchedUrl || url } : {}),
        originKind: acquisition,
        operations,
      }),
    [acquisition, fetchedUrl, url]
  );

  const requestReencodeApproval = useCallback(
    (candidates: readonly ReencodeCandidate[]) =>
      new Promise<ReadonlySet<string>>(resolve =>
        setReencodeChoice({
          candidates,
          resolve: approved =>
            resolve(
              approved
                ? new Set(candidates.map(candidate => candidate.operation.operationId))
                : new Set()
            ),
        })
      ),
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
        approvedRequestIds,
        acquisition
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
          started: counts.started + Number(entry.outcome.status === 'started'),
          failed: counts.failed + Number(entry.outcome.status === 'failed'),
          skipped: counts.skipped + Number(entry.outcome.status === 'skipped'),
          notAttempted: counts.notAttempted + Number(entry.outcome.status === 'not-attempted'),
        }),
        { pending: 0, started: 0, failed: 0, skipped: 0, notAttempted: 0 }
      );
      if (summary.pending > 0) {
        setStatus('downloading');
        setMessage('Downloading…');
        return;
      }
      setStatus(summary.failed || next.batchFailure ? 'error' : 'done');
      setMessage(
        next.batchFailure
          ? `${FAILURE_PRESENTATION[next.batchFailure.code].title}. ${summary.notAttempted} not attempted.`
          : summary.failed
            ? `${summary.started} started, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.notAttempted} not attempted.`
            : summary.skipped > 0
              ? `${summary.started} started, ${summary.skipped} skipped.`
              : `${summary.started} item${summary.started === 1 ? '' : 's'} started.`
      );
    },
  });
  clearAttemptRef.current = downloadAttempt.clear;

  const refetchAndRetry = useCallback(async () => {
    if (acquisition !== 'instants' || !downloadAttempt.attempt) {
      await handleFetch();
      return;
    }
    setStatus('fetching');
    setMessage('Refreshing active Instants…');
    const response = (await browser.runtime.sendMessage({ type: 'FETCH_INSTANTS' })) as {
      media?: Omit<MediaItem, 'index' | 'selected'>[];
      failure?: OperationFailure;
      error?: string;
    };
    if (response.failure) {
      setSourceFailure(response.failure);
      setStatus('error');
      setMessage(
        `${FAILURE_PRESENTATION[response.failure.code].title}. ${FAILURE_PRESENTATION[response.failure.code].explanation}`
      );
      return;
    }
    if (response.error || !response.media) {
      setStatus('error');
      setMessage('GramGrab could not refresh active Instants.');
      return;
    }
    const selectedMediaIds = new Set(
      mediaItems.flatMap(item => (item.selected && item.mediaId ? [item.mediaId] : []))
    );
    const refreshed = response.media.map((item, index) => ({
      ...item,
      index,
      selected: item.mediaId ? selectedMediaIds.has(item.mediaId) : false,
    }));
    replaceMediaItems(refreshed);
    setSourceFailure(undefined);
    await downloadAttempt.retryWithFreshMedia(
      refreshed.map(item => ({
        displayIndex: item.index,
        itemIndex: item.itemIndex ?? item.index,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        type: item.type,
        url: item.url,
      }))
    );
  }, [acquisition, downloadAttempt, handleFetch, mediaItems, replaceMediaItems]);

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
        operationId: createOperationId(),
        requestId: createRequestId(),
        itemIndex: item.itemIndex ?? item.index,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        originalUrl: item.url,
        originalFilename: `${item.filenameHint}_${item.index + 1}.mp4`,
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
    const operations = planExportOperations(
      mediaItems.map(item =>
        exportCandidate(item, frameExportSettings, frameRuntime, removeAudioIndexes)
      )
    );
    if (!initialWorkspaceMode && operations.some(operation => operation.mode === 'silent')) {
      const createdAt = Date.now();
      const snapshot = {
        version: 4 as const,
        acquisition: { kind: acquisition } as const,
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
    acquisition,
    fetchedUrl,
    frameExportSettings,
    frameRuntime,
    initialWorkspaceMode,
    mediaItems,
    message,
    removeAudioIndexes,
    url,
  ]);
  const handleDownloadRef = useRef(handleDownload);

  useEffect(() => {
    handleDownloadRef.current = handleDownload;
  }, [handleDownload]);

  const selectedCount = mediaItems.filter(m => m.selected).length;
  const allSelected = mediaItems.length > 0 && selectedCount === mediaItems.length;

  const switchAcquisition = useCallback(
    (next: 'source' | 'instants') => {
      if (next === acquisition || isWorkspaceBusy(status)) return;
      setAcquisition(next);
      setFetchedUrl('');
      replaceMediaItems([]);
      setFrameExportSettings({});
      setRemoveAudioIndexes(new Set());
      setSourceFailure(undefined);
      clearAttemptRef.current();
      setStatus('idle');
      setMessage(next === 'instants' ? 'Ready to load active Instants.' : 'Awaiting URL.');
    },
    [acquisition, replaceMediaItems, status]
  );

  const toggleAll = useCallback(() => {
    const newSelected = !allSelected;
    setMediaItems(prev => prev.map(item => ({ ...item, selected: newSelected })));
  }, [allSelected]);

  const isBusy = isWorkspaceBusy(status) || downloadAttempt.busy;
  const activeFailures = useMemo(
    () => [
      ...(sourceFailure ? [sourceFailure] : []),
      ...(downloadAttempt.attempt?.batchFailure ? [downloadAttempt.attempt.batchFailure] : []),
      ...(downloadAttempt.attempt?.entries.flatMap(entry =>
        entry.outcome.status === 'failed' ? [entry.outcome.failure] : []
      ) ?? []),
    ],
    [downloadAttempt.attempt, sourceFailure]
  );
  const hasRecoveryAction = useCallback(
    (action: RecoveryAction) =>
      activeFailures.some(item => FAILURE_PRESENTATION[item.code].actions.includes(action)),
    [activeFailures]
  );
  const canCopyDiagnostics = hasRecoveryAction('copy-diagnostics');
  const canDownloadOriginal = hasRecoveryAction('download-original');
  const canTryReencode = hasRecoveryAction('try-reencode');
  const canRefetchSource = hasRecoveryAction('refetch-source');
  const canOpenInstagram = acquisition === 'source' && hasRecoveryAction('open-in-instagram');
  const canReloadWorkspace = hasRecoveryAction('reload-workspace');
  const previewDiagnostics = useCallback(
    (trigger: HTMLButtonElement) => {
      const current = downloadAttempt.attempt;
      const diagnosticFailure = current?.batchFailure ?? sourceFailure;
      if (!current && !diagnosticFailure) return;
      setDiagnosticsPreview({
        trigger,
        json: diagnosticsForAttempt(current, diagnosticFailure, fetchedUrl || url),
      });
    },
    [downloadAttempt.attempt, fetchedUrl, sourceFailure, url]
  );
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
      setStatus('error');
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
        results?: {
          status: 'started' | 'failed';
          failure?: { code: keyof typeof FAILURE_PRESENTATION };
        }[];
        frame?: {
          itemIndex: number;
          mediaId?: string;
          url: string;
          filenameHint: string;
          timestampSeconds: number;
          sourceUrl: string;
          originKind: 'source' | 'instants';
        };
        silent?: {
          itemIndex: number;
          mediaId?: string;
          url: string;
          filenameHint: string;
          sourceUrl: string;
          originKind: 'source' | 'instants';
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
          version: 4 as const,
          acquisition: { kind: response.silent.originKind } as const,
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
        const timestampSeconds = response.frame.timestampSeconds;
        const result = await executeFrameExport(
          {
            operationId: createOperationId(),
            requestId: createRequestId(),
            itemIndex: response.frame.itemIndex,
            ...(response.frame.mediaId ? { mediaId: response.frame.mediaId } : {}),
            url: response.frame.url,
            originalUrl: response.frame.url,
            filename: frameFilename(response.frame.filenameHint, timestampSeconds),
            originalFilename: `${response.frame.filenameHint}.mp4`,
            mediaType: 'video',
            mode: 'frame',
            displayIndex: 0,
            frameTimestampSeconds: timestampSeconds,
          },
          response.frame.sourceUrl,
          { originKind: response.frame.originKind }
        );
        setMessage(
          result.status === 'started'
            ? result.warning
              ? 'Frame downloaded, but history could not be saved.'
              : 'Frame download started.'
            : 'Frame export failed. Download the original video or try again.'
        );
        if (result.status === 'failed') setStatus('error');
      } else {
        const failed = response.results?.find(result => result.status === 'failed');
        const failure = failed?.failure ? FAILURE_PRESENTATION[failed.failure.code] : undefined;
        if (response.error || failure) setStatus('error');
        setMessage(
          response.error ??
            (failure ? `${failure.title}. ${failure.explanation}` : 'Download started.')
        );
      }
      setHistoryBusy(null);
      if (!response.error) void loadHistory();
    },
    [loadHistory]
  );
  const removeHistoryEntry = useCallback(async (entryId: string) => {
    const response = (await browser.runtime.sendMessage({
      type: 'DELETE_HISTORY_ENTRY',
      entryId,
    })) as { entries?: HistoryEntry[]; error?: string };
    if (response.error) {
      setStatus('error');
      setMessage(response.error);
    } else setHistoryEntries(response.entries ?? []);
  }, []);
  const clearDownloadHistory = useCallback(async () => {
    if (!window.confirm('Clear all download history?')) return;
    const response = (await browser.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_HISTORY' })) as {
      error?: string;
    };
    if (response.error) {
      setStatus('error');
      setMessage(response.error);
    } else setHistoryEntries([]);
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
    requestFetch,
    downloadIntent,
  } = useWorkspaceSurface({
    acquisition,
    setAcquisition,
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

  const triggerFetch = useCallback(
    (target: 'source' | 'instants') => {
      switchAcquisition(target);
      requestFetch(target);
    },
    [requestFetch, switchAcquisition]
  );

  useEffect(() => {
    if (fetchIntent && fetchIntent.target === acquisition) void handleFetchRef.current();
  }, [acquisition, fetchIntent]);

  useEffect(() => {
    if (downloadIntent > 0) void handleDownloadRef.current();
  }, [downloadIntent]);

  const emptyMessage = status === 'done' && mediaItems.length === 0 ? message : 'No media yet.';
  const mediaListModel = {
    mediaItems,
    intrinsicDimensions,
    allSelected,
    fallbackLoading,
    fallbackFailed,
    frameExportSettings,
    removeAudioIndexes,
    frameRuntime,
    attempt: downloadAttempt.attempt,
    emptyMessage,
  };
  const mediaListActions = {
    onPreviewError: handlePreviewError,
    onToggle: toggleItem,
    onToggleAll: toggleAll,
    onToggleExportFrame: toggleExportFrame,
    onToggleRemoveAudio: toggleRemoveAudio,
    onChangeFrameTimestamp: changeFrameTimestamp,
    onRetryFrameMetadata: loadFrameMetadata,
    onRetryFrameExport: (index: number) => void handleExportFrame(index),
    onVideoRef: handleVideoRef,
    onVideoMetadata: handleVideoMetadata,
    onIntrinsicDimensions: handleIntrinsicDimensions,
  };

  return (
    <div className={`container${workspaceMode ? ' workspace-container' : ''}`}>
      <header className="ext-header">
        <PopupHeader
          workspaceMode={workspaceMode}
          workspaceExists={workspaceExists}
          isBusy={isBusy}
          showHistory={showHistory}
          onToggleHistory={() => (showHistory ? setShowHistory(false) : openHistory())}
          onOpenWorkspace={handleOpenWorkspace}
        />
      </header>

      <div className="ext-body">
        {status === 'error' && (
          <p className="status-message error" role="status" aria-live="polite">
            {message}
          </p>
        )}
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
            <div className="ext-section fetch-section">
              <div className="fetch-row">
                <input
                  id="source-url"
                  className={`url-input${autoDetected ? ' detected' : ''}`}
                  type="url"
                  aria-label="Instagram source URL"
                  placeholder="Paste an Instagram URL…"
                  value={url}
                  disabled={isBusy}
                  onChange={e => handleUrlChange(e.currentTarget.value)}
                  onBlur={() =>
                    setUrl(current => canonicalizeInstagramUrl(current)?.url ?? current)
                  }
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !isBusy && url.trim()) triggerFetch('source');
                  }}
                />
                <button
                  className="btn"
                  onClick={() => triggerFetch('source')}
                  disabled={isBusy || !url.trim()}
                >
                  {renderFetchButtonLabel(status, acquisition)}
                </button>
              </div>
              {autoDetected && status === 'idle' && (
                <p className="detected-hint">Instagram URL detected — ready to fetch.</p>
              )}
              <div className="instants-row">
                <button
                  type="button"
                  className="instants-btn"
                  onClick={() => triggerFetch('instants')}
                  disabled={isBusy}
                >
                  {renderInstantsButtonLabel(status, acquisition)}
                </button>
              </div>
              {sourceFailure && (
                <section className="download-attempt-summary" aria-live="polite">
                  <strong>{FAILURE_PRESENTATION[sourceFailure.code].title}</strong>
                  <span>{FAILURE_PRESENTATION[sourceFailure.code].explanation}</span>
                  <code>{sourceFailure.code}</code>
                  {canRefetchSource && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void refetchAndRetry()}
                      disabled={isBusy}
                    >
                      {acquisition === 'instants' ? 'Refresh feed and retry' : 'Fetch source again'}
                    </button>
                  )}
                  {canOpenInstagram && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void browser.tabs.create({ url: fetchedUrl || url })}
                    >
                      Open in Instagram
                    </button>
                  )}
                  {canCopyDiagnostics && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={event => previewDiagnostics(event.currentTarget)}
                    >
                      Copy diagnostics
                    </button>
                  )}
                </section>
              )}
            </div>

            <MediaListSection
              model={mediaListModel}
              actions={mediaListActions}
              workspaceMode={workspaceMode}
              disabled={isBusy}
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
                    {downloadAttempt.summary.started} started, {downloadAttempt.summary.failed}{' '}
                    failed, {downloadAttempt.summary.skipped} skipped,{' '}
                    {downloadAttempt.summary.notAttempted} not attempted
                  </strong>
                  {downloadAttempt.attempt.batchFailure && (
                    <span className="download-item-status failed">
                      {FAILURE_PRESENTATION[downloadAttempt.attempt.batchFailure.code].title}:{' '}
                      {FAILURE_PRESENTATION[downloadAttempt.attempt.batchFailure.code].explanation}{' '}
                      <code>{downloadAttempt.attempt.batchFailure.code}</code>
                    </span>
                  )}
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
                  {canRefetchSource && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void refetchAndRetry()}
                      disabled={isBusy}
                    >
                      {acquisition === 'instants' ? 'Refresh feed and retry' : 'Fetch source again'}
                    </button>
                  )}
                  {canOpenInstagram && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void browser.tabs.create({ url: fetchedUrl || url })}
                    >
                      Open in Instagram
                    </button>
                  )}
                  {canReloadWorkspace && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => window.location.reload()}
                    >
                      Reload workspace
                    </button>
                  )}
                  {canCopyDiagnostics && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={event => previewDiagnostics(event.currentTarget)}
                    >
                      Copy diagnostics
                    </button>
                  )}
                  {canDownloadOriginal && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void downloadAttempt.downloadOriginals()}
                      disabled={isBusy}
                    >
                      Download original
                    </button>
                  )}
                  {canTryReencode && (
                    <button
                      type="button"
                      className="workspace-secondary"
                      onClick={() => void downloadAttempt.tryReencode()}
                      disabled={isBusy}
                    >
                      Try re-encoding
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

      {workspaceMode ? (
        <WorkspaceSelectionActions
          selectedCount={selectedCount}
          mediaCount={mediaItems.length}
          allSelected={allSelected}
          isBusy={isBusy}
          isDownloading={status === 'downloading'}
          onToggleAll={toggleAll}
          onDownload={handleDownload}
        />
      ) : (
        <WorkspaceReplacementAction
          workspaceExists={workspaceExists}
          hasTransferableSession={hasTransferableSession}
          confirmReplace={confirmReplace}
          isBusy={isBusy}
          setConfirmReplace={setConfirmReplace}
          onReplace={handleReplaceWorkspace}
        />
      )}

      <footer className="ext-footer">
        <span className="footer-brand">GramGrab</span>
        <span className="footer-tagline">Posts · Reels · Stories</span>
      </footer>
      {reencodeChoice && (
        <ReencodeDialog candidates={reencodeChoice.candidates} onChoice={settleReencodeChoice} />
      )}
      {diagnosticsPreview && (
        <DiagnosticsDialog
          json={diagnosticsPreview.json}
          onClose={() => {
            const trigger = diagnosticsPreview.trigger;
            setDiagnosticsPreview(undefined);
            queueMicrotask(() => trigger.focus());
          }}
        />
      )}
    </div>
  );
}

function DiagnosticsDialog({ json, onClose }: { json: string; onClose: () => void }) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => titleRef.current?.focus(), []);
  return (
    <div className="quality-dialog-backdrop" onMouseDown={onClose}>
      <section
        className="quality-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <h2 id="diagnostics-dialog-title" ref={titleRef} tabIndex={-1}>
          Diagnostics preview
        </h2>
        <p>
          This can include the Instagram source, temporary media URLs, filenames, operation IDs,
          technical messages, and stacks. Share it only with someone you trust.
        </p>
        <pre className="diagnostics-preview">{json}</pre>
        <div className="quality-dialog-actions">
          <button type="button" className="workspace-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void navigator.clipboard.writeText(json).then(onClose)}
          >
            Copy diagnostics
          </button>
        </div>
      </section>
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
              {entry.origin.kind === 'source' ? (
                <a
                  className="history-source-link"
                  href={entry.origin.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open source for item ${entry.itemIndex + 1}`}
                  title={entry.origin.sourceUrl}
                >
                  Open source ↗
                </a>
              ) : (
                <span className="history-source-link">Active Instants feed</span>
              )}
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
  showHistory,
  onToggleHistory,
  onOpenWorkspace,
}: {
  workspaceMode: boolean;
  workspaceExists: boolean;
  isBusy: boolean;
  showHistory: boolean;
  onToggleHistory: () => void;
  onOpenWorkspace: () => Promise<void>;
}) {
  return (
    <>
      <div className="ext-logo">
        Gram<em>Grab</em>
      </div>
      <div className="ext-meta">
        <button
          className="workspace-secondary"
          type="button"
          onClick={onToggleHistory}
          aria-pressed={showHistory}
        >
          {showHistory ? 'Results' : 'History'}
        </button>
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

function WorkspaceSelectionActions({
  selectedCount,
  mediaCount,
  allSelected,
  isBusy,
  isDownloading,
  onToggleAll,
  onDownload,
}: {
  selectedCount: number;
  mediaCount: number;
  allSelected: boolean;
  isBusy: boolean;
  isDownloading: boolean;
  onToggleAll: () => void;
  onDownload: () => Promise<void>;
}) {
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

function WorkspaceReplacementAction({
  workspaceExists,
  hasTransferableSession,
  confirmReplace,
  isBusy,
  setConfirmReplace,
  onReplace,
}: {
  workspaceExists: boolean;
  hasTransferableSession: boolean;
  confirmReplace: boolean;
  isBusy: boolean;
  setConfirmReplace: (value: boolean) => void;
  onReplace: () => Promise<void>;
}) {
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

function renderFetchButtonLabel(status: Status, acquisition: 'source' | 'instants') {
  return status === 'fetching' && acquisition === 'source' ? (
    <>
      <span className="btn-spinner" />
      Fetching…
    </>
  ) : (
    'Fetch Media'
  );
}

function renderInstantsButtonLabel(status: Status, acquisition: 'source' | 'instants') {
  return status === 'fetching' && acquisition === 'instants' ? (
    <>
      <span className="btn-spinner" />
      Loading Instants…
    </>
  ) : (
    'Load Instants'
  );
}

type MediaListModel = {
  mediaItems: MediaItem[];
  intrinsicDimensions: Record<number, { width: number; height: number }>;
  allSelected: boolean;
  fallbackLoading: Set<number>;
  fallbackFailed: Set<number>;
  frameExportSettings: Record<number, FrameExportSetting>;
  removeAudioIndexes: Set<number>;
  frameRuntime: Record<number, FrameRuntime>;
  attempt: ReturnType<typeof useDownloadAttempt>['attempt'];
  emptyMessage: string;
};

type MediaListActions = {
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
};

function useMediaMasonry({
  mediaItems,
  workspaceMode,
  intrinsicDimensions,
}: {
  mediaItems: MediaItem[];
  workspaceMode: boolean;
  intrinsicDimensions: Record<number, { width: number; height: number }>;
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

  return { masonryRef, masonryColumns };
}

function MediaListSection({
  model,
  actions,
  workspaceMode,
  disabled,
}: {
  model: MediaListModel;
  actions: MediaListActions;
  workspaceMode: boolean;
  disabled: boolean;
}) {
  const {
    mediaItems,
    intrinsicDimensions,
    allSelected,
    fallbackLoading,
    fallbackFailed,
    frameExportSettings,
    removeAudioIndexes,
    frameRuntime,
    attempt,
    emptyMessage,
  } = model;
  const {
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
  } = actions;
  const { masonryRef, masonryColumns } = useMediaMasonry({
    mediaItems,
    workspaceMode,
    intrinsicDimensions,
  });

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
          <span className="media-count-label" role="status" aria-live="polite">
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
          <p className="media-empty" aria-live="polite">
            {emptyMessage}
          </p>
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
        {item.creatorUsername && <span className="item-creator">@{item.creatorUsername}</span>}
        {attemptEntry?.outcome.status === 'pending' && (
          <span className="download-item-status pending">
            {attemptEntry.outcome.phase
              ? `${attemptEntry.outcome.phase} ${Math.round((attemptEntry.outcome.progress ?? 0) * 100)}%`
              : attemptEntry.operation.mode === 'frame'
                ? 'Exporting…'
                : 'Starting…'}
          </span>
        )}
        {attemptEntry?.outcome.status === 'started' && (
          <span className="download-item-status accepted">
            {attemptEntry.operation.mode === 'frame' ? 'Frame exported' : 'Download started'}
          </span>
        )}
        {attemptEntry?.outcome.status === 'started' && attemptEntry.outcome.warning && (
          <span className="download-item-status warning">
            {WARNING_PRESENTATION[attemptEntry.outcome.warning.code]}
          </span>
        )}
        {attemptEntry?.outcome.status === 'failed' && (
          <span className="download-item-status failed" id={`download-result-${item.index}`}>
            {FAILURE_PRESENTATION[attemptEntry.outcome.failure.code].title}:{' '}
            {FAILURE_PRESENTATION[attemptEntry.outcome.failure.code].explanation}{' '}
            <code>{attemptEntry.outcome.failure.code}</code>
          </span>
        )}
        {attemptEntry?.outcome.status === 'skipped' && (
          <span className="download-item-status skipped">
            Skipped: re-encoding was declined. <code>{attemptEntry.outcome.code}</code>
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
