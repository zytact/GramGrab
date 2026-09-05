import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { FAILURE_PRESENTATION, presentationForFailure } from './errors/presentation';
import { buildDiagnostics, buildWhatsAppDiagnostics } from './errors/diagnostics';
import type { AttemptOperation, DownloadAttempt } from './download/attempt';
import { useDownloadAttempt } from './download/use-download-attempt';
import { ExportCandidate, planExportOperations } from './download/coordinator';
import {
  clampFrameSecond,
  defaultFrameSecond,
  frameFilename,
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
import { isPositiveFinitePair } from './workspace/media-ratio';
import { runSilentVideoBatch, type ReencodeCandidate } from './silent-video/batch';
import { silentProgressMessage } from './silent-video/progress';
import { isWhatsAppWebUrl } from './whatsapp/limits';
import type { HistoryEntry } from './history/contracts';
import { LoadingButtonLabel } from './popup/loading-button-label';
import {
  itemRuntimeAt,
  updateItemRuntime,
  withFrame,
  type ItemRuntime,
  type ItemRuntimes,
  type MediaItem,
} from './popup/media-item';
import { MediaListSection } from './popup/media-list';
import { useFrameSeekEffect } from './popup/use-frame-seek';
import { useWhatsAppCapture } from './popup/use-whatsapp-capture';
import { WhatsAppStatusPanel } from './popup/whatsapp-status-panel';
import { sendMessage } from './messaging/send';

type Status = 'idle' | 'fetching' | 'downloading' | 'done' | 'error';

/** Reassurance appended when a redownload fails: the stored history entry is left untouched. */
const HISTORY_KEPT = 'History was kept.';

const VIDEO_METADATA_UNAVAILABLE = 'Could not load video metadata. Retry.';

/**
 * Fetches one video through the background worker and measures it. A failure the worker classified
 * is reported in its own words; anything the popup itself could not do stays generic.
 */
async function loadVideoMetadata(
  url: string
): Promise<{ dataUrl: string; durationSeconds: number } | { error: string }> {
  try {
    const response = await sendMessage({ type: 'FETCH_VIDEO_BLOB', url });
    if (!response.dataUrl)
      return {
        error: response.failure ? failureMessage(response.failure) : VIDEO_METADATA_UNAVAILABLE,
      };
    return {
      dataUrl: response.dataUrl,
      durationSeconds: await getVideoDuration(response.dataUrl),
    };
  } catch {
    return { error: VIDEO_METADATA_UNAVAILABLE };
  }
}

/** Holds one item's chosen frame second inside a newly measured duration. */
function withClampedFrameSecond(
  settings: Record<number, FrameExportSetting>,
  index: number,
  durationSeconds: number,
  resetToDefault: boolean
): Record<number, FrameExportSetting> {
  const setting = settings[index];
  if (!setting) return settings;
  const requested = resetToDefault ? defaultFrameSecond(durationSeconds) : setting.timestampSeconds;
  return {
    ...settings,
    [index]: { ...setting, timestampSeconds: clampFrameSecond(requested, durationSeconds) },
  };
}

/** The one way the popup turns a failure into a sentence a person reads. */
function failureMessage(failure: OperationFailure, suffix?: string): string {
  const presentation = presentationForFailure(failure);
  return `${presentation.title}. ${presentation.explanation}${suffix ? ` ${suffix}` : ''}`;
}

function exportCandidate(
  item: MediaItem,
  frameExportSettings: Record<number, FrameExportSetting>,
  itemRuntimes: ItemRuntimes,
  removeAudioIndexes: ReadonlySet<number>
): ExportCandidate {
  const setting = frameExportSettings[item.index];
  const durationSeconds = itemRuntimes[item.index]?.frame.durationSeconds;
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
  return buildDiagnostics({
    extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
    userAgent: navigator.userAgent,
    sourceUrl,
    attempt: current,
    ...(diagnosticFailure ? { batchFailure: diagnosticFailure } : {}),
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
  const [itemRuntimes, setItemRuntimes] = useState<ItemRuntimes>({});
  const [removeAudioIndexes, setRemoveAudioIndexes] = useState<Set<number>>(new Set());
  const [autoDetected, setAutoDetected] = useState(false);
  const [platform, setPlatform] = useState<'instagram' | 'whatsapp'>('instagram');
  const [whatsappActive, setWhatsappActive] = useState(false);
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

  const whatsapp = useWhatsAppCapture({ eligible: whatsappActive, videoRefs });

  useEffect(() => {
    let cancelled = false;
    void browser.tabs
      .query({ active: true, currentWindow: true })
      .then(tabs => {
        if (cancelled) return;
        const tab = tabs.length === 1 ? tabs[0] : undefined;
        const isEligible = tab?.id !== undefined && isWhatsAppWebUrl(tab.url);
        setWhatsappActive(isEligible);
        if (isEligible && !initialWorkspaceMode) setPlatform('whatsapp');
      })
      .catch(() => {
        if (!cancelled) setWhatsappActive(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialWorkspaceMode]);

  const patchRuntime = useCallback(
    (index: number, update: (current: ItemRuntime) => ItemRuntime) =>
      setItemRuntimes(previous => updateItemRuntime(previous, index, update)),
    []
  );

  const replaceMediaItems = useCallback<typeof setMediaItems>(action => {
    resultsGeneration.current++;
    pendingFrameDefaults.current.clear();
    setItemRuntimes({});
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
      patchRuntime(item.index, current =>
        current.intrinsic?.width === width && current.intrinsic.height === height
          ? current
          : { ...current, intrinsic: { width, height } }
      );
    },
    [patchRuntime]
  );

  const toggleItem = useCallback((index: number) => {
    setMediaItems(prev =>
      prev.map(item => (item.index === index ? { ...item, selected: !item.selected } : item))
    );
  }, []);

  const setFrameDuration = useCallback(
    (index: number, durationSeconds: number) => {
      const maximum = maximumFrameSecond(durationSeconds);
      if (maximum === undefined) return;
      patchRuntime(index, current =>
        withFrame(current, { ...current.frame, status: 'ready', durationSeconds, error: undefined })
      );
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
    },
    [patchRuntime]
  );

  useFrameSeekEffect(frameExportSettings, itemRuntimes, videoRefs);

  const loadFrameMetadata = useCallback(
    async (index: number) => {
      const generation = resultsGeneration.current;
      const itemUrl = mediaItems[index]?.url;
      if (!itemUrl) return;
      const video = videoRefs.current[index];
      if (video && maximumFrameSecond(video.duration) !== undefined) {
        setFrameDuration(index, video.duration);
        return;
      }
      patchRuntime(index, current => withFrame(current, { status: 'loading' }));
      const loaded = await loadVideoMetadata(itemUrl);
      if (generation !== resultsGeneration.current || mediaItems[index]?.url !== itemUrl) return;
      if ('error' in loaded) {
        patchRuntime(index, current =>
          withFrame(current, { status: 'failed', error: loaded.error })
        );
        return;
      }
      patchRuntime(index, current => withFrame(current, { status: 'ready', ...loaded }));
      const resetToDefault = pendingFrameDefaults.current.delete(index);
      setFrameExportSettings(previous =>
        withClampedFrameSecond(previous, index, loaded.durationSeconds, resetToDefault)
      );
    },
    [mediaItems, patchRuntime, setFrameDuration]
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

  const changeFrameTimestamp = useCallback(
    (index: number, timestampSeconds: number) => {
      setFrameExportSettings(previous => ({
        ...previous,
        [index]: { enabled: true, timestampSeconds },
      }));
      patchRuntime(index, current =>
        withFrame(current, {
          ...current.frame,
          status: 'ready',
          error: undefined,
          warning: undefined,
        })
      );
    },
    [patchRuntime]
  );

  const requestFallbackPreview = useCallback(
    async (index: number, itemUrl: string) => {
      patchRuntime(index, current => ({ ...current, preview: 'loading' }));
      try {
        const res = await sendMessage({ type: 'GET_PREVIEW_URL', url: itemUrl });

        if (res?.previewUrl) {
          setMediaItems(prev =>
            prev.map(item =>
              item.index === index ? { ...item, previewUrl: res.previewUrl } : item
            )
          );
          patchRuntime(index, current => ({ ...current, preview: 'idle' }));
        } else {
          patchRuntime(index, current => ({
            ...current,
            preview: 'failed',
            ...(res?.failure ? { previewFailure: res.failure } : {}),
          }));
        }
      } catch {
        patchRuntime(index, current => ({ ...current, preview: 'failed' }));
      }
    },
    [patchRuntime]
  );

  const executeFrameAttempt = useCallback(
    async (operation: AttemptOperation): Promise<DownloadOperationResult> => {
      const index = operation.displayIndex;
      const frame = itemRuntimes[index]?.frame;
      if (!frame?.durationSeconds || operation.frameTimestampSeconds === undefined)
        return DownloadFailedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'failed',
          failure: normalizeFrameFailure('no-duration'),
        });
      patchRuntime(index, current =>
        withFrame(current, { ...current.frame, status: 'exporting', error: undefined })
      );
      const result = await executeFrameExport(operation, fetchedUrl || url, {
        originKind: acquisition,
      });
      patchRuntime(index, current =>
        withFrame(
          current,
          result.status === 'started'
            ? {
                ...current.frame,
                status: 'ready',
                ...(result.warning
                  ? { warning: 'Frame downloaded, but history could not be saved.' }
                  : {}),
              }
            : { ...current.frame, status: 'failed', error: 'Frame export failed.' }
        )
      );
      return result;
    },
    [acquisition, fetchedUrl, itemRuntimes, patchRuntime, url]
  );

  const executeDirect = useCallback(
    (operations: readonly DownloadOperation[]) =>
      sendMessage({
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
    const response = await sendMessage({ type: 'FETCH_INSTANTS' });
    if (response.failure) {
      setSourceFailure(response.failure);
      setStatus('error');
      setMessage(failureMessage(response.failure));
      return;
    }
    if (!response.media) {
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
      const durationSeconds = itemRuntimes[index]?.frame.durationSeconds;
      if (!item || !setting?.enabled || !durationSeconds) return;
      const timestampSeconds = clampFrameSecond(setting.timestampSeconds, durationSeconds);
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
    [executeFrameAttempt, frameExportSettings, itemRuntimes, mediaItems]
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
        exportCandidate(item, frameExportSettings, itemRuntimes, removeAudioIndexes)
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
    initialWorkspaceMode,
    itemRuntimes,
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

  const isBusy = isWorkspaceBusy(status) || downloadAttempt.busy || whatsapp.busy;
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
  const whatsappFailure = whatsapp.failure;
  const previewWhatsAppDiagnostics = useCallback(
    (trigger: HTMLButtonElement) => {
      if (!whatsappFailure) return;
      setDiagnosticsPreview({
        trigger,
        json: buildWhatsAppDiagnostics({
          extensionVersion: browser.runtime.getManifest().version ?? '0.0.0',
          userAgent: navigator.userAgent,
          failure: whatsappFailure,
        }),
      });
    },
    [whatsappFailure]
  );
  const handleUrlChange = useCallback((nextUrl: string) => {
    setUrl(nextUrl);
    setAutoDetected(false);
  }, []);
  const handlePreviewError = useCallback(
    (item: MediaItem) => {
      if (itemRuntimeAt(itemRuntimes, item.index).preview !== 'idle') return;
      // The fallback data URL only feeds the image preview; a video preview always plays item.url.
      if (item.type === 'video') {
        patchRuntime(item.index, current => ({ ...current, preview: 'failed' }));
        return;
      }
      if (item.previewUrl?.startsWith('data:') === true) return;
      void requestFallbackPreview(item.index, item.url);
    },
    [itemRuntimes, patchRuntime, requestFallbackPreview]
  );
  const handleVideoRef = useCallback((index: number, el: HTMLVideoElement | null) => {
    videoRefs.current[index] = el;
  }, []);

  const loadHistory = useCallback(async () => {
    const response = await sendMessage({ type: 'GET_DOWNLOAD_HISTORY' });
    if (response.failure) {
      setStatus('error');
      setMessage(failureMessage(response.failure));
      return;
    }
    setHistoryEntries([...response.entries]);
  }, []);

  const openHistory = useCallback(() => {
    setShowHistory(true);
    void loadHistory();
  }, [loadHistory]);
  const redownloadHistory = useCallback(
    // fallow-ignore-next-line complexity
    async (entryId: string) => {
      setHistoryBusy(entryId);
      const response = await sendMessage({ type: 'REDOWNLOAD_HISTORY_ENTRY', entryId });
      const redownloadFailure = 'failure' in response ? response.failure : undefined;
      if ('silent' in response) {
        const createdAt = Date.now();
        const item = {
          index: 0,
          itemIndex: response.silent.itemIndex,
          ...(response.silent.mediaId ? { mediaId: response.silent.mediaId } : {}),
          type: 'video' as const,
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
      } else if ('frame' in response) {
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
        const failed =
          'results' in response
            ? response.results.find(result => result.status === 'failed')
            : undefined;
        const failure = failed?.status === 'failed' ? failed.failure : undefined;
        if (redownloadFailure || failure) setStatus('error');
        setMessage(
          redownloadFailure
            ? failureMessage(redownloadFailure, HISTORY_KEPT)
            : failure
              ? failureMessage(failure)
              : 'Download started.'
        );
      }
      setHistoryBusy(null);
      if (!redownloadFailure) void loadHistory();
    },
    [loadHistory]
  );
  const removeHistoryEntry = useCallback(async (entry: HistoryEntry) => {
    const response = await ('source' in entry
      ? sendMessage({ type: 'DELETE_WHATSAPP_HISTORY_RECEIPT', receipt: entry })
      : sendMessage({ type: 'DELETE_HISTORY_ENTRY', entryId: entry.id }));
    if (response.failure) {
      setStatus('error');
      setMessage(failureMessage(response.failure));
    } else setHistoryEntries([...response.entries]);
  }, []);
  const clearDownloadHistory = useCallback(async () => {
    if (!window.confirm('Clear all download history?')) return;
    const response = await sendMessage({ type: 'CLEAR_DOWNLOAD_HISTORY' });
    if (response.failure) {
      setStatus('error');
      setMessage(failureMessage(response.failure));
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
    itemRuntimes,
    allSelected,
    frameExportSettings,
    removeAudioIndexes,
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
    onVideoMetadata: setFrameDuration,
    onIntrinsicDimensions: handleIntrinsicDimensions,
  };

  return (
    <div className={`container${workspaceMode ? ' workspace-container' : ''}`}>
      <header className="ext-header">
        <PopupHeader
          workspaceMode={workspaceMode}
          workspaceExists={workspaceExists}
          showWorkspace={platform === 'instagram'}
          isBusy={isBusy}
          showHistory={showHistory}
          onToggleHistory={() => (showHistory ? setShowHistory(false) : openHistory())}
          onOpenWorkspace={handleOpenWorkspace}
        />
      </header>

      <div className="ext-body">
        <div className="popup-layout">
          {!workspaceMode && <PlatformNavigation platform={platform} onChange={setPlatform} />}
          <div className="popup-content">
            {platform === 'instagram' && status === 'error' && (
              <p className="status-message error" role="status" aria-live="polite">
                {message}
              </p>
            )}
            {showHistory ? (
              <HistoryView
                entries={
                  workspaceMode
                    ? historyEntries.filter(entry => !('source' in entry))
                    : historyEntries
                }
                busyId={historyBusy}
                onRedownload={redownloadHistory}
                onRemove={removeHistoryEntry}
                onClear={clearDownloadHistory}
              />
            ) : (
              <>
                {platform === 'whatsapp' && !workspaceMode ? (
                  <WhatsAppStatusPanel
                    eligible={whatsappActive}
                    capture={whatsapp}
                    onVideoRef={handleVideoRef}
                    onCopyDiagnostics={previewWhatsAppDiagnostics}
                    disabled={isBusy}
                  />
                ) : (
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
                        aria-busy={status === 'fetching' && acquisition === 'source'}
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
                        aria-busy={status === 'fetching' && acquisition === 'instants'}
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
                            {acquisition === 'instants'
                              ? 'Refresh feed and retry'
                              : 'Fetch source again'}
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
                )}

                {(platform === 'instagram' || workspaceMode) && (
                  <>
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
                            {downloadAttempt.summary.started} started,{' '}
                            {downloadAttempt.summary.failed} failed,{' '}
                            {downloadAttempt.summary.skipped} skipped,{' '}
                            {downloadAttempt.summary.notAttempted} not attempted
                          </strong>
                          {downloadAttempt.attempt.batchFailure && (
                            <span className="download-item-status failed">
                              {
                                FAILURE_PRESENTATION[downloadAttempt.attempt.batchFailure.code]
                                  .title
                              }
                              :{' '}
                              {
                                FAILURE_PRESENTATION[downloadAttempt.attempt.batchFailure.code]
                                  .explanation
                              }{' '}
                              <code>{downloadAttempt.attempt.batchFailure.code}</code>
                            </span>
                          )}
                          {downloadAttempt.summary.warnings > 0 && (
                            <span>
                              {' '}
                              {downloadAttempt.summary.warnings} started with a history warning.
                            </span>
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
                              {acquisition === 'instants'
                                ? 'Refresh feed and retry'
                                : 'Fetch source again'}
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
                        aria-busy={status === 'downloading'}
                      >
                        {renderDownloadButtonLabel(status, selectedCount)}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
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
      ) : platform === 'instagram' ? (
        <WorkspaceReplacementAction
          workspaceExists={workspaceExists}
          hasTransferableSession={hasTransferableSession}
          confirmReplace={confirmReplace}
          isBusy={isBusy}
          setConfirmReplace={setConfirmReplace}
          onReplace={handleReplaceWorkspace}
        />
      ) : null}

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

function PlatformNavigation({
  platform,
  onChange,
}: {
  platform: 'instagram' | 'whatsapp';
  onChange: (platform: 'instagram' | 'whatsapp') => void;
}) {
  return (
    <nav className="platform-navigation" aria-label="Download platform">
      <button
        type="button"
        className={platform === 'instagram' ? 'active' : undefined}
        aria-current={platform === 'instagram' ? 'page' : undefined}
        onClick={() => onChange('instagram')}
      >
        Instagram
      </button>
      <button
        type="button"
        className={platform === 'whatsapp' ? 'active' : undefined}
        aria-current={platform === 'whatsapp' ? 'page' : undefined}
        onClick={() => onChange('whatsapp')}
      >
        WhatsApp Status
      </button>
    </nav>
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
          This contains only the extension version, capture time, normalized browser and platform
          details, structural media URL metadata, attempt counts, media kinds, outcomes, and
          structured failure or warning codes. It excludes source and media URLs, filenames,
          operation IDs, technical causes, and full user-agent strings. Share it only with someone
          you trust.
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
  onRemove: (entry: HistoryEntry) => void;
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
        {entries.map(entry =>
          'source' in entry ? (
            <article
              className="history-entry"
              key={`whatsapp-${entry.timestamp}-${entry.savedFilename}`}
            >
              <div className="history-entry-topline">
                <span className={`item-type-badge ${entry.mediaKind}`}>{entry.mediaKind}</span>
                <span className="history-source-link">WhatsApp</span>
                <time
                  title={new Date(entry.timestamp).toLocaleString()}
                  dateTime={new Date(entry.timestamp).toISOString()}
                >
                  {relativeHistoryTime(entry.timestamp)}
                </time>
              </div>
              <span className="history-filename" title={entry.savedFilename}>
                {entry.savedFilename}
              </span>
              <div className="history-entry-footer">
                <span className="history-source-link">{entry.outcome}</span>
                <button
                  className="history-remove"
                  type="button"
                  onClick={() => onRemove(entry)}
                  aria-label="Remove WhatsApp receipt from history"
                  title="Remove from history"
                >
                  ×
                </button>
              </div>
            </article>
          ) : (
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
                  onClick={() => onRemove(entry)}
                  aria-label={`Remove item ${entry.itemIndex + 1} from history`}
                  title="Remove from history"
                >
                  ×
                </button>
              </div>
            </article>
          )
        )}
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
  showWorkspace,
  isBusy,
  showHistory,
  onToggleHistory,
  onOpenWorkspace,
}: {
  workspaceMode: boolean;
  workspaceExists: boolean;
  showWorkspace: boolean;
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
        {!workspaceMode && showWorkspace && (
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
        aria-busy={isDownloading}
      >
        {isDownloading ? (
          <LoadingButtonLabel>Downloading…</LoadingButtonLabel>
        ) : (
          'Download selected'
        )}
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

function renderDownloadButtonLabel(status: Status, selectedCount: number) {
  if (status === 'downloading') {
    return <LoadingButtonLabel>Downloading…</LoadingButtonLabel>;
  }

  return selectedCount > 0 ? `Download ${selectedCount} Selected` : 'Download Selected';
}

function renderFetchButtonLabel(status: Status, acquisition: 'source' | 'instants') {
  return status === 'fetching' && acquisition === 'source' ? (
    <LoadingButtonLabel>Fetching…</LoadingButtonLabel>
  ) : (
    'Fetch Media'
  );
}

function renderInstantsButtonLabel(status: Status, acquisition: 'source' | 'instants') {
  return status === 'fetching' && acquisition === 'instants' ? (
    <LoadingButtonLabel>Loading Instants…</LoadingButtonLabel>
  ) : (
    'Load Instants'
  );
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
