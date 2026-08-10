import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
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
import {
  normalizeBrowserDownloadFailure,
  normalizeFrameFailure,
  normalizeWhatsAppCaptureFailure,
} from './errors/normalize';
import {
  FAILURE_PRESENTATION,
  presentationForFailure,
  WARNING_PRESENTATION,
} from './errors/presentation';
import { buildDiagnostics, buildWhatsAppDiagnostics } from './errors/diagnostics';
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
import {
  captureWhatsAppVisibleStatus,
  WhatsAppCaptureError,
  type WhatsAppCaptureHandle,
} from './whatsapp/capture';
import { isWhatsAppWebUrl } from './whatsapp/limits';
import { WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY } from './whatsapp/disclosure';
import { exportWhatsAppFrame } from './whatsapp/export';
import type { HistoryEntry } from './history/contracts';

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
type WhatsAppDisclosureState = 'checking' | 'required' | 'dismissed' | 'acknowledged';
type WhatsAppCaptureStatus = 'idle' | 'capturing' | 'ready' | 'downloading' | 'started' | 'failed';
type WhatsAppOperation = {
  operationId: ReturnType<typeof createOperationId>;
  requestId: ReturnType<typeof createRequestId>;
  manualRetryCount: number;
};

function nextWhatsAppOperation(
  status: WhatsAppCaptureStatus,
  previous: WhatsAppOperation | undefined
): WhatsAppOperation {
  return status === 'failed' && previous
    ? {
        operationId: previous.operationId,
        requestId: createRequestId(),
        manualRetryCount: previous.manualRetryCount + 1,
      }
    : { operationId: createOperationId(), requestId: createRequestId(), manualRetryCount: 0 };
}

function whatsAppDownloadContext(
  handle: WhatsAppCaptureHandle | undefined,
  item: MediaItem | undefined,
  operation: WhatsAppOperation | undefined,
  status: WhatsAppCaptureStatus
):
  | {
      readonly handle: WhatsAppCaptureHandle;
      readonly item: MediaItem;
      readonly operation: WhatsAppOperation;
    }
  | undefined {
  return handle && item?.selected && operation && status !== 'downloading'
    ? { handle, item, operation }
    : undefined;
}

function downloadWhatsAppSelection(
  handle: WhatsAppCaptureHandle,
  item: MediaItem,
  operation: WhatsAppOperation,
  frameSetting: FrameExportSetting | undefined
) {
  if (!frameSetting?.enabled) return handle.download();
  return exportWhatsAppFrame(handle, {
    operationId: operation.operationId,
    requestId: operation.requestId,
    itemIndex: 0,
    url: item.url,
    originalUrl: item.url,
    originalFilename: handle.filename,
    filename: frameFilename(
      handle.filename.replace(/\.[^.]+$/u, ''),
      frameSetting.timestampSeconds
    ),
    mediaType: 'video',
    mode: 'frame',
    displayIndex: 0,
    frameTimestampSeconds: frameSetting.timestampSeconds,
  });
}

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
  const [frameRuntime, setFrameRuntime] = useState<Record<number, FrameRuntime>>({});
  const [removeAudioIndexes, setRemoveAudioIndexes] = useState<Set<number>>(new Set());
  const [fallbackLoading, setFallbackLoading] = useState<Set<number>>(new Set());
  const [fallbackFailed, setFallbackFailed] = useState<Set<number>>(new Set());
  const [intrinsicDimensions, setIntrinsicDimensions] = useState<
    Record<number, { width: number; height: number }>
  >({});
  const [autoDetected, setAutoDetected] = useState(false);
  const [platform, setPlatform] = useState<'instagram' | 'whatsapp'>('instagram');
  const [whatsappActive, setWhatsappActive] = useState(false);
  const [whatsappDisclosure, setWhatsappDisclosure] = useState<WhatsAppDisclosureState>('checking');
  const [whatsappCaptureStatus, setWhatsappCaptureStatus] = useState<
    'idle' | 'capturing' | 'ready' | 'downloading' | 'started' | 'failed'
  >('idle');
  const [whatsappCaptureMessage, setWhatsappCaptureMessage] = useState(
    'Capture the photo or video Visible Status currently open in WhatsApp Web.'
  );
  const [whatsappFailure, setWhatsappFailure] = useState<OperationFailure>();
  const [whatsappMediaItem, setWhatsappMediaItem] = useState<MediaItem>();
  const [whatsappFrameSetting, setWhatsappFrameSetting] = useState<FrameExportSetting>();
  const [whatsappFrameRuntime, setWhatsappFrameRuntime] = useState<FrameRuntime>();
  const [whatsappOperation, setWhatsappOperation] = useState<WhatsAppOperation>();
  const whatsappHandleRef = useRef<WhatsAppCaptureHandle | undefined>(undefined);
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
      whatsappHandleRef.current?.release();
      whatsappHandleRef.current = undefined;
    };
  }, [initialWorkspaceMode]);

  useEffect(() => {
    let cancelled = false;
    if (!whatsappActive) {
      setWhatsappDisclosure('checking');
      return () => {
        cancelled = true;
      };
    }
    setWhatsappDisclosure('checking');
    void browser.storage
      .get(WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY)
      .then(stored => {
        if (!cancelled)
          setWhatsappDisclosure(
            stored[WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY] === true ? 'acknowledged' : 'required'
          );
      })
      .catch(() => {
        if (!cancelled) setWhatsappDisclosure('required');
      });
    return () => {
      cancelled = true;
    };
  }, [whatsappActive]);

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

  const acknowledgeWhatsAppViewReceipts = useCallback(async () => {
    try {
      await browser.storage.set({ [WHATSAPP_VIEW_RECEIPT_ACKNOWLEDGED_KEY]: true });
      setWhatsappDisclosure('acknowledged');
    } catch {
      setWhatsappCaptureMessage('GramGrab could not remember this acknowledgement. Try again.');
    }
  }, []);

  const handleWhatsAppCapture = useCallback(async () => {
    if (whatsappDisclosure !== 'acknowledged') {
      setWhatsappDisclosure('required');
      return;
    }
    if (whatsappCaptureStatus === 'capturing') return;
    const operation = nextWhatsAppOperation(whatsappCaptureStatus, whatsappOperation);
    setWhatsappOperation(operation);
    setWhatsappFailure(undefined);
    setWhatsappCaptureStatus('capturing');
    setWhatsappCaptureMessage('Reading the Visible Status…');
    try {
      const handle = await captureWhatsAppVisibleStatus({
        operationId: operation.operationId,
        requestId: operation.requestId,
      });
      whatsappHandleRef.current?.release();
      whatsappHandleRef.current = handle;
      const descriptor = handle.descriptor;
      setWhatsappMediaItem({
        index: 0,
        type: descriptor.kind === 'video' ? 'video' : 'image',
        url: handle.snapshot.objectUrl(),
        filenameHint: 'visible-status',
        selected: true,
        width: descriptor.width,
        height: descriptor.height,
      });
      setWhatsappFrameSetting(undefined);
      setWhatsappFrameRuntime(
        descriptor.kind === 'video'
          ? {
              status: 'ready',
              durationSeconds: descriptor.durationMs / 1_000,
            }
          : undefined
      );
      setWhatsappCaptureStatus('ready');
      setWhatsappCaptureMessage('Visible Status captured. Choose an export to start the download.');
    } catch (error) {
      const captureError =
        error instanceof WhatsAppCaptureError ? error : new WhatsAppCaptureError('transfer-failed');
      const failure =
        captureError.reason === 'download-failed' && captureError.browserCause !== undefined
          ? normalizeBrowserDownloadFailure(captureError.browserCause, 'whatsapp')
          : normalizeWhatsAppCaptureFailure(captureError.reason, captureError.shape);
      setWhatsappFailure(failure);
      setWhatsappCaptureStatus('failed');
      const presentation = presentationForFailure(failure);
      setWhatsappCaptureMessage(`${presentation.title}. ${presentation.explanation}`);
    }
  }, [whatsappCaptureStatus, whatsappDisclosure, whatsappOperation]);

  const handleWhatsAppDownload = useCallback(async () => {
    const context = whatsAppDownloadContext(
      whatsappHandleRef.current,
      whatsappMediaItem,
      whatsappOperation,
      whatsappCaptureStatus
    );
    if (!context) return;
    const { handle, item, operation } = context;
    setWhatsappCaptureStatus('downloading');
    setWhatsappFailure(undefined);
    try {
      const result = await downloadWhatsAppSelection(handle, item, operation, whatsappFrameSetting);
      if ('status' in result && result.status === 'failed') {
        setWhatsappFailure(result.failure);
        setWhatsappCaptureStatus('failed');
        setWhatsappCaptureMessage(
          `${presentationForFailure(result.failure).title}. ${presentationForFailure(result.failure).explanation}`
        );
        setWhatsappMediaItem(undefined);
        whatsappHandleRef.current = undefined;
        return;
      }
      whatsappHandleRef.current = undefined;
      setWhatsappMediaItem(undefined);
      setWhatsappCaptureStatus('started');
      setWhatsappCaptureMessage(
        result.warning
          ? WARNING_PRESENTATION[result.warning.code]
          : 'Download started. The in-memory capture was released.'
      );
    } catch (error) {
      const failure =
        error instanceof WhatsAppCaptureError && error.browserCause !== undefined
          ? normalizeBrowserDownloadFailure(error.browserCause, 'whatsapp')
          : normalizeWhatsAppCaptureFailure('transfer-failed');
      setWhatsappFailure(failure);
      setWhatsappMediaItem(undefined);
      whatsappHandleRef.current = undefined;
      setWhatsappCaptureStatus('failed');
      setWhatsappCaptureMessage(
        `${presentationForFailure(failure).title}. ${presentationForFailure(failure).explanation}`
      );
    }
  }, [whatsappCaptureStatus, whatsappFrameSetting, whatsappMediaItem, whatsappOperation]);

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

  const isBusy =
    isWorkspaceBusy(status) || downloadAttempt.busy || whatsappCaptureStatus === 'capturing';
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
  const removeHistoryEntry = useCallback(async (entry: HistoryEntry) => {
    const response = (await browser.runtime.sendMessage(
      'source' in entry
        ? { type: 'DELETE_WHATSAPP_HISTORY_RECEIPT', receipt: entry }
        : { type: 'DELETE_HISTORY_ENTRY', entryId: entry.id }
    )) as { entries?: HistoryEntry[]; error?: string };
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
                  <WhatsAppStatusSurface
                    eligible={whatsappActive}
                    disclosure={whatsappDisclosure}
                    status={whatsappCaptureStatus}
                    message={whatsappCaptureMessage}
                    failure={whatsappFailure}
                    item={whatsappMediaItem}
                    frameSetting={whatsappFrameSetting}
                    frameRuntime={whatsappFrameRuntime}
                    manualRetryCount={whatsappOperation?.manualRetryCount ?? 0}
                    onAcknowledge={() => void acknowledgeWhatsAppViewReceipts()}
                    onDismissDisclosure={() => setWhatsappDisclosure('dismissed')}
                    onReviewDisclosure={() => setWhatsappDisclosure('required')}
                    onCapture={() => void handleWhatsAppCapture()}
                    onDownload={() => void handleWhatsAppDownload()}
                    onToggleItem={() =>
                      setWhatsappMediaItem(current =>
                        current ? { ...current, selected: !current.selected } : current
                      )
                    }
                    onToggleFrame={() =>
                      setWhatsappFrameSetting(current => ({
                        enabled: !(current?.enabled ?? false),
                        timestampSeconds: current?.timestampSeconds ?? 0,
                      }))
                    }
                    onChangeFrameTimestamp={timestampSeconds =>
                      setWhatsappFrameSetting({ enabled: true, timestampSeconds })
                    }
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

type WhatsAppCaptureSectionProps = {
  disclosure: WhatsAppDisclosureState;
  status: WhatsAppCaptureStatus;
  message: string;
  failure: OperationFailure | undefined;
  manualRetryCount: number;
  onAcknowledge: () => void;
  onDismissDisclosure: () => void;
  onReviewDisclosure: () => void;
  onCapture: () => void;
  onCopyDiagnostics: (trigger: HTMLButtonElement) => void;
  disabled: boolean;
};

type WhatsAppCaptureReadyProps = Omit<
  WhatsAppCaptureSectionProps,
  'disclosure' | 'onAcknowledge' | 'onDismissDisclosure' | 'onReviewDisclosure'
>;

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

type WhatsAppStatusSurfaceProps = WhatsAppCaptureSectionProps & {
  eligible: boolean;
  item: MediaItem | undefined;
  frameSetting: FrameExportSetting | undefined;
  frameRuntime: FrameRuntime | undefined;
  onDownload: () => void;
  onToggleItem: () => void;
  onToggleFrame: () => void;
  onChangeFrameTimestamp: (timestampSeconds: number) => void;
};

function WhatsAppStatusSurface({
  eligible,
  item,
  frameSetting,
  frameRuntime,
  onDownload,
  onToggleItem,
  onToggleFrame,
  onChangeFrameTimestamp,
  ...captureProps
}: WhatsAppStatusSurfaceProps) {
  if (!eligible)
    return (
      <section className="ext-section whatsapp-capture-section" aria-labelledby="whatsapp-title">
        <h1 id="whatsapp-title">Open WhatsApp Web</h1>
        <p className="whatsapp-capture-copy">
          Open web.whatsapp.com, then open the photo or video Status you want to capture.
        </p>
      </section>
    );

  if (!item) return <WhatsAppCaptureSection {...captureProps} />;

  const model: MediaListModel = {
    mediaItems: [item],
    intrinsicDimensions: {},
    allSelected: item.selected,
    fallbackLoading: new Set(),
    fallbackFailed: new Set(),
    frameExportSettings: frameSetting ? { 0: frameSetting } : {},
    removeAudioIndexes: new Set(),
    frameRuntime: frameRuntime ? { 0: frameRuntime } : {},
    attempt: undefined,
    emptyMessage: '',
  };
  const actions: MediaListActions = {
    onPreviewError: () => {},
    onToggle: onToggleItem,
    onToggleAll: onToggleItem,
    onToggleExportFrame: onToggleFrame,
    onToggleRemoveAudio: () => {},
    onChangeFrameTimestamp,
    onRetryFrameMetadata: () => {},
    onRetryFrameExport: () => {},
    onVideoRef: () => {},
    onVideoMetadata: () => {},
    onIntrinsicDimensions: () => {},
  };
  return (
    <>
      <section className="ext-section whatsapp-capture-section" aria-labelledby="whatsapp-title">
        <h1 id="whatsapp-title">Visible Status captured</h1>
        <p className="whatsapp-capture-copy">
          This is the one photo or video that was visible when you captured it. It stays in memory
          only until this download starts.
        </p>
      </section>
      <MediaListSection
        model={model}
        actions={actions}
        workspaceMode={false}
        disabled={captureProps.disabled}
        allowSilent={false}
        showPreview={false}
        compact
      />
      <div className="ext-section">
        <button
          type="button"
          className="btn"
          onClick={onDownload}
          disabled={!item.selected || captureProps.disabled}
          aria-busy={captureProps.status === 'downloading'}
        >
          {captureProps.status === 'downloading' ? (
            <LoadingButtonLabel>Downloading…</LoadingButtonLabel>
          ) : (
            'Download Visible Status'
          )}
        </button>
      </div>
    </>
  );
}

function WhatsAppCaptureSection({
  disclosure,
  onAcknowledge,
  onDismissDisclosure,
  onReviewDisclosure,
  ...readyProps
}: WhatsAppCaptureSectionProps) {
  if (disclosure === 'acknowledged') return <WhatsAppCaptureReady {...readyProps} />;
  return (
    <WhatsAppCaptureShell title="Before using WhatsApp Status">
      <WhatsAppViewReceiptDisclosure
        disclosure={disclosure}
        onAcknowledge={onAcknowledge}
        onDismiss={onDismissDisclosure}
        onReview={onReviewDisclosure}
      />
    </WhatsAppCaptureShell>
  );
}

function WhatsAppCaptureReady(props: WhatsAppCaptureReadyProps) {
  const presentation = props.failure ? presentationForFailure(props.failure) : undefined;
  const canCapture = canCaptureWhatsAppStatus(props.status, props.manualRetryCount, presentation);
  return (
    <WhatsAppCaptureShell title={presentation?.title ?? 'Capture the Visible Status'}>
      <p className="whatsapp-capture-copy">{props.message}</p>
      <p className="whatsapp-capture-note">
        One click captures only the already-visible photo or video. The capture stays in memory for
        this download and is then released.
      </p>
      {canCapture && (
        <WhatsAppCaptureButton
          status={props.status}
          disabled={props.disabled}
          onCapture={props.onCapture}
        />
      )}
      {props.status === 'failed' && props.failure && (
        <WhatsAppCaptureFailure
          failure={props.failure}
          canCopyDiagnostics={presentation?.actions.includes('copy-diagnostics') ?? false}
          onCopyDiagnostics={props.onCopyDiagnostics}
        />
      )}
    </WhatsAppCaptureShell>
  );
}

function canCaptureWhatsAppStatus(
  status: WhatsAppCaptureReadyProps['status'],
  manualRetryCount: number,
  presentation: ReturnType<typeof presentationForFailure> | undefined
): boolean {
  if (status !== 'failed') return true;
  if (!presentation?.actions.includes('retry-operation')) return false;
  return presentation.retry !== 'once' || manualRetryCount === 0;
}

function WhatsAppCaptureButton({
  status,
  disabled,
  onCapture,
}: Pick<WhatsAppCaptureSectionProps, 'status' | 'disabled' | 'onCapture'>) {
  return (
    <button
      type="button"
      className="btn"
      onClick={onCapture}
      disabled={disabled || status === 'ready' || status === 'downloading' || status === 'started'}
      aria-busy={status === 'capturing'}
    >
      {whatsAppCaptureButtonLabel(status)}
    </button>
  );
}

function whatsAppCaptureButtonLabel(status: WhatsAppCaptureSectionProps['status']) {
  if (status === 'capturing') return <LoadingButtonLabel>Capturing…</LoadingButtonLabel>;
  if (status === 'downloading') return <LoadingButtonLabel>Downloading…</LoadingButtonLabel>;
  if (status === 'started') return 'Download started';
  return status === 'failed' ? 'Capture Visible Status again' : 'Capture Visible Status';
}

function WhatsAppCaptureFailure({
  failure,
  canCopyDiagnostics,
  onCopyDiagnostics,
}: {
  failure: OperationFailure;
  canCopyDiagnostics: boolean;
  onCopyDiagnostics: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="status-message error" role="status">
      <code>{failure.code}</code>
      {canCopyDiagnostics && (
        <button
          type="button"
          className="workspace-secondary"
          onClick={event => onCopyDiagnostics(event.currentTarget)}
        >
          Copy diagnostics
        </button>
      )}
    </div>
  );
}

function WhatsAppCaptureShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      className="ext-section whatsapp-capture-section"
      aria-labelledby="whatsapp-capture-title"
    >
      <h1 id="whatsapp-capture-title">{title}</h1>
      {children}
    </section>
  );
}

function WhatsAppViewReceiptDisclosure({
  disclosure,
  onAcknowledge,
  onDismiss,
  onReview,
}: {
  disclosure: WhatsAppDisclosureState;
  onAcknowledge: () => void;
  onDismiss: () => void;
  onReview: () => void;
}) {
  if (disclosure === 'checking')
    return <p className="whatsapp-capture-copy">Preparing the capture notice…</p>;
  if (disclosure === 'dismissed')
    return (
      <div className="whatsapp-view-receipt-disclosure">
        <p className="whatsapp-capture-copy">
          Review the view-receipt notice before capturing a Visible Status.
        </p>
        <button type="button" className="btn" onClick={onReview}>
          Review notice
        </button>
      </div>
    );
  return (
    <div className="whatsapp-view-receipt-disclosure" role="status">
      <p className="whatsapp-capture-copy">
        WhatsApp controls view receipts. GramGrab does not provide anonymous viewing.
      </p>
      <div className="quality-dialog-actions">
        <button type="button" className="workspace-secondary" onClick={onDismiss}>
          Not now
        </button>
        <button type="button" className="btn" onClick={onAcknowledge}>
          Continue
        </button>
      </div>
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

function LoadingButtonLabel({ children }: { children: string }) {
  return (
    <span className="loading-button-label">
      <span className="btn-spinner" aria-hidden="true" />
      {children}
    </span>
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
  allowSilent = true,
  showPreview = true,
  compact = false,
}: {
  model: MediaListModel;
  actions: MediaListActions;
  workspaceMode: boolean;
  disabled: boolean;
  allowSilent?: boolean;
  showPreview?: boolean;
  compact?: boolean;
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
      showPreview={showPreview}
      intrinsicDimensions={intrinsicDimensions[item.index]}
      fallbackLoading={fallbackLoading.has(item.index)}
      fallbackFailed={fallbackFailed.has(item.index)}
      onError={() => onPreviewError(item)}
      onToggle={() => onToggle(item.index)}
      frameSetting={frameExportSettings[item.index]}
      removeAudio={allowSilent && removeAudioIndexes.has(item.index)}
      allowSilent={allowSilent}
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
    <div className={`ext-section${compact ? ' whatsapp-result-list' : ''}`} style={{ flex: 1 }}>
      {!compact && mediaItems.length > 0 && (
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
  showPreview: boolean;
  intrinsicDimensions?: { width: number; height: number };
  fallbackLoading: boolean;
  fallbackFailed: boolean;
  onError: () => void;
  onToggle: () => void;
  frameSetting?: FrameExportSetting;
  removeAudio: boolean;
  allowSilent: boolean;
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
  | 'showPreview'
  | 'frameSetting'
  | 'removeAudio'
  | 'allowSilent'
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
  allowSilent,
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
  | 'allowSilent'
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
          {allowSilent && (
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
          )}
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
    showPreview,
    intrinsicDimensions,
    fallbackLoading,
    fallbackFailed,
    onError,
    onToggle,
    frameSetting,
    removeAudio,
    allowSilent,
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

      {showPreview && (
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
      )}

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
        allowSilent={allowSilent}
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
