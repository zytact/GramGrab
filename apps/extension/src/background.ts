import { Either, Effect, Schema } from 'effect';
import { browser } from './lib/browser.ts';
import { startNativeBridge } from './native-bridge.ts';
import {
  CommandFailure,
  Completed,
  CommandResult,
  DebugExportResult,
  DebugGetResult,
  Export as ProtocolExport,
  ExportOperation as ProtocolExportOperation,
  ExportResult as ProtocolExportResult,
  DirectExport,
  FrameExport,
  HistoryClearResult,
  HistoryEntry as ProtocolHistoryEntry,
  HistoryListResult,
  HistoryMarker as ProtocolHistoryMarker,
  HistoryRedownloadFailed,
  HistoryRedownloadResult,
  HistoryRedownloadStarted,
  HistoryRemoveResult,
  HumanItemNumber,
  InspectResult,
  InstantsInspectResult,
  InstantsExport as ProtocolInstantsExport,
  InspectedMedia,
  InternalItemIndex,
  ItemFailed,
  ItemSucceeded,
  MediaIdentity,
  OperationFailure as ProtocolOperationFailure,
  OperationId as ProtocolOperationId,
  Progress,
  Rejected,
  SilentExport,
  validationFailureFrom,
  type EventPayload,
  type Request,
} from '@gramgrab/protocol';
import {
  canonicalizeInstagramUrl,
  WORKSPACE_TRANSFER_TTL_MS,
  type WorkspaceSnapshot,
} from './workspace/contracts.ts';
import { replaceWorkspace } from './workspace/coordinator.ts';
import { historySource } from './history/source.ts';
import { reconcileHistoryEntry } from './history/reconciliation.ts';
import {
  appendHistory,
  appendHistoryEntries,
  appendWhatsAppHistoryReceipt,
  clearHistory,
  getHistory,
  removeHistoryEntries,
  removeWhatsAppHistoryReceipt,
} from './history/repository.ts';
import {
  decodeWhatsAppHistoryReceipt,
  type DownloadHistoryEntry,
  type HistoryMarker,
} from './history/contracts.ts';
import { jsonToDataUrl } from './lib/data-url.ts';
import {
  fetchInstantMediaItems,
  parseInstagramUrl,
  resolveMediaEffect,
} from './instagram/acquisition.ts';
import { runOperationHandler } from './effect/runtime.ts';
import { fetchBlobAsDataUrl } from './effect/instagram.ts';
import { fetchRestShortcodeRaw } from './instagram/rest-shortcode.ts';
import type { MediaItem } from './instagram/normalize.ts';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadMediaResponse,
  createOperationId,
  createRequestId,
  type DownloadOperation,
  type DownloadOperationResult,
} from './download/contracts.ts';
import {
  decodeMessage,
  type BackgroundMessageType,
  type MessageOf,
  type MessageResponse,
  type MessageType,
} from './messaging/contracts.ts';
import { MESSAGE_REFUSALS } from './messaging/refusals.ts';
import { sendTabMessage } from './messaging/send.ts';
import { formatError } from './effect/errors.ts';
import { OperationFailure, OperationWarning } from './errors/contracts.ts';
import { PersonRequests } from './instagram/requests.ts';
import {
  previewInboxEntry,
  previewWatchTarget,
  runWatchCommand,
  runWatchRead,
} from './watch/service.ts';
import { watchAvatars } from './watch/avatar-image.ts';
import { refreshBadge } from './watch/attention.ts';
import {
  ALARM_NAME,
  ensureAlarm,
  holdForStartup,
  initializeScheduler,
  pump,
} from './watch/scheduler.ts';
import { notifiedWatch } from './watch/notify.ts';
import { acceptedHistoryEntry, type AcceptedHistoryOperation } from './history/receipt.ts';
import { buildDiagnostics } from './errors/diagnostics.ts';
import {
  historyFailure,
  normalizeBrowserDownloadFailure,
  normalizeMediaTransferFailure,
  normalizeSourceFailure,
} from './errors/normalize.ts';

const DOWNLOAD_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index]!, index);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------------------
// Handler functions — each returns a structured response value
// ---------------------------------------------------------------------------

function hasValidMediaDimensions(
  item: MediaItem
): item is MediaItem & { width: number; height: number } {
  return (
    Number.isFinite(item.width) &&
    Number.isFinite(item.height) &&
    item.width! > 0 &&
    item.height! > 0
  );
}

async function handleFetchMedia(
  msg: MessageOf<'FETCH_MEDIA'>
): Promise<MessageResponse<'FETCH_MEDIA'>> {
  const source = historySource(msg.url);
  if (!source)
    return {
      media: undefined,
      failure: OperationFailure.make({
        code: 'INPUT_INVALID_SOURCE_URL',
        phase: 'input',
        scope: 'batch',
      }),
    };
  const result = await runOperationHandler(
    resolveMediaEffect(source.url).pipe(Effect.map(items => ({ items }))),
    { items: undefined as MediaItem[] | undefined },
    normalizeSourceFailure
  );
  if (result.failure || !result.items) return { media: undefined, failure: result.failure };
  const stored = await getHistory();
  if (stored.kind === 'unknown-version')
    return { media: undefined, failure: historyFailure('HISTORY_VERSION_UNSUPPORTED') };
  const instagramHistory = stored.entries.filter(
    (entry): entry is DownloadHistoryEntry => 'origin' in entry
  );
  return {
    sourceUrl: source.url,
    media: result.items.map(item => ({
      url: item.url,
      itemIndex: item.itemIndex,
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      type: item.type,
      filenameHint: item.filenameHint,
      previewUrl: item.previewUrl,
      history: historyMarker(instagramHistory, source.url, item),
      ...(hasValidMediaDimensions(item) ? { width: item.width, height: item.height } : {}),
      ...(item.creatorUsername ? { creatorUsername: item.creatorUsername } : {}),
      ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
    })),
  };
}

async function handleFetchInstants(
  _msg: MessageOf<'FETCH_INSTANTS'>
): Promise<MessageResponse<'FETCH_INSTANTS'>> {
  const result = await runOperationHandler(
    fetchInstantMediaItems().pipe(Effect.map(items => ({ items }))),
    { items: undefined as MediaItem[] | undefined },
    normalizeSourceFailure
  );
  if (result.failure || !result.items) return { media: undefined, failure: result.failure };
  const stored = await getHistory();
  if (stored.kind === 'unknown-version')
    return { media: undefined, failure: historyFailure('HISTORY_VERSION_UNSUPPORTED') };
  const instagramHistory = stored.entries.filter(
    (entry): entry is DownloadHistoryEntry => 'origin' in entry
  );
  return {
    acquisition: 'instants' as const,
    media: result.items.map(item => ({
      url: item.url,
      itemIndex: item.itemIndex,
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      type: item.type,
      filenameHint: item.filenameHint,
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
      ...(item.creatorUsername ? { creatorUsername: item.creatorUsername } : {}),
      history: historyMarker(instagramHistory, { kind: 'instants' }, item),
      ...(hasValidMediaDimensions(item) ? { width: item.width, height: item.height } : {}),
    })),
  };
}

function historyMarker(
  entries: readonly DownloadHistoryEntry[],
  origin: DownloadHistoryEntry['origin'] | string,
  item: MediaItem
): HistoryMarker {
  const matches = entries.filter(
    entry =>
      (typeof origin === 'string'
        ? entry.origin.kind === 'source' && entry.origin.sourceUrl === origin
        : entry.origin.kind === origin.kind) &&
      reconcileHistoryEntry(entry, [item]).kind === 'found'
  );
  const latest = matches.reduce<number | undefined>(
    (value, entry) =>
      value === undefined || entry.downloadedAt > value ? entry.downloadedAt : value,
    undefined
  );
  return {
    downloaded: matches.length > 0,
    count: matches.length,
    ...(latest ? { latestDownloadedAt: latest } : {}),
  };
}

async function handleGetPreviewUrl(
  msg: MessageOf<'GET_PREVIEW_URL'>
): Promise<MessageResponse<'GET_PREVIEW_URL'>> {
  return runOperationHandler(
    fetchBlobAsDataUrl(msg.url).pipe(Effect.map(previewUrl => ({ previewUrl }))),
    { previewUrl: undefined },
    normalizeMediaTransferFailure
  );
}

type DownloadAttempt = { operation: DownloadOperation; result: DownloadOperationResult };

async function downloadItem(operation: DownloadOperation): Promise<DownloadAttempt> {
  try {
    await browser.downloads.download({
      url: operation.url,
      filename: operation.filename,
      saveAs: false,
    });
    return {
      operation,
      result: DownloadAcceptedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'started',
      }),
    };
  } catch (cause) {
    return {
      operation,
      result: DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeBrowserDownloadFailure(cause),
      }),
    };
  }
}

async function appendAcceptedHistory(
  item: AcceptedHistoryOperation,
  origin: DownloadHistoryEntry['origin']
) {
  await appendHistory(acceptedHistoryEntry(item, origin));
}

/**
 * One history write covers a whole download batch. A failed write warns every entry it would have
 * held, so an item still reports its own history outcome.
 */
async function recordAcceptedHistory(
  attempts: readonly DownloadAttempt[],
  origin: DownloadHistoryEntry['origin']
): Promise<DownloadOperationResult[]> {
  const accepted = attempts.filter(attempt => attempt.result.status === 'started');
  if (accepted.length === 0) return attempts.map(attempt => attempt.result);
  try {
    await appendHistoryEntries(
      accepted.map(attempt => acceptedHistoryEntry(attempt.operation, origin))
    );
    return attempts.map(attempt => attempt.result);
  } catch {
    return attempts.map(attempt =>
      attempt.result.status === 'started'
        ? DownloadAcceptedResult.make({
            operationId: attempt.operation.operationId,
            requestId: attempt.operation.requestId,
            status: 'started',
            warning: OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' }),
          })
        : attempt.result
    );
  }
}

async function handleDownloadMedia(
  request: MessageOf<'DOWNLOAD_MEDIA'>
): Promise<MessageResponse<'DOWNLOAD_MEDIA'>> {
  const source = request.sourceUrl ? historySource(request.sourceUrl) : null;
  if (request.sourceUrl && !source)
    return DownloadMediaResponse.make({
      results: [],
      failure: OperationFailure.make({
        code: 'INPUT_INVALID_SOURCE_URL',
        phase: 'input',
        scope: 'batch',
      }),
    });
  const origin =
    request.originKind === 'instants'
      ? ({ kind: 'instants' } as const)
      : source
        ? ({ kind: 'source', sourceUrl: source.url, sourceKind: source.kind } as const)
        : undefined;
  const attempts = await mapWithConcurrency(request.operations, DOWNLOAD_CONCURRENCY, downloadItem);
  return DownloadMediaResponse.make({
    results: origin
      ? await recordAcceptedHistory(attempts, origin)
      : attempts.map(attempt => attempt.result),
  });
}

async function handleGetDownloadHistory(): Promise<MessageResponse<'GET_DOWNLOAD_HISTORY'>> {
  const history = await getHistory();
  return history.kind === 'unknown-version'
    ? { entries: [], failure: historyFailure('HISTORY_VERSION_UNSUPPORTED') }
    : { entries: [...history.entries].reverse(), failure: undefined };
}

async function handleRecordWhatsAppHistory(
  message: MessageOf<'RECORD_WHATSAPP_HISTORY'>
): Promise<MessageResponse<'RECORD_WHATSAPP_HISTORY'>> {
  const receipt = decodeWhatsAppHistoryReceipt(message.receipt);
  if (Either.isLeft(receipt)) return { warning: 'HISTORY_SAVE_FAILED' };
  try {
    await appendWhatsAppHistoryReceipt(receipt.right);
    return { saved: true };
  } catch {
    return { warning: 'HISTORY_SAVE_FAILED' };
  }
}

async function handleDeleteWhatsAppHistoryReceipt(
  message: MessageOf<'DELETE_WHATSAPP_HISTORY_RECEIPT'>
): Promise<MessageResponse<'DELETE_WHATSAPP_HISTORY_RECEIPT'>> {
  const receipt = decodeWhatsAppHistoryReceipt(message.receipt);
  if (Either.isLeft(receipt))
    return { entries: [], failure: historyFailure('HISTORY_ENTRY_NOT_FOUND') };
  try {
    const entries = await removeWhatsAppHistoryReceipt(receipt.right);
    return { entries: [...entries].reverse(), failure: undefined };
  } catch {
    return { entries: [], failure: historyFailure('HISTORY_STORE_FAILED') };
  }
}

// fallow-ignore-next-line complexity
async function handleRedownloadHistoryEntry(
  msg: MessageOf<'REDOWNLOAD_HISTORY_ENTRY'>
): Promise<MessageResponse<'REDOWNLOAD_HISTORY_ENTRY'>> {
  const history = await getHistory();
  if (history.kind === 'unknown-version')
    return { failure: historyFailure('HISTORY_VERSION_UNSUPPORTED') };
  const entry = history.entries.find(
    (candidate): candidate is DownloadHistoryEntry =>
      'id' in candidate && candidate.id === msg.entryId
  );
  if (!entry) return { failure: historyFailure('HISTORY_ENTRY_NOT_FOUND') };
  const resolved =
    entry.origin.kind === 'instants'
      ? await runOperationHandler(
          fetchInstantMediaItems().pipe(Effect.map(items => ({ items }))),
          {
            items: undefined as MediaItem[] | undefined,
          },
          normalizeSourceFailure
        )
      : await runOperationHandler(
          resolveMediaEffect(entry.origin.sourceUrl).pipe(Effect.map(items => ({ items }))),
          { items: undefined as MediaItem[] | undefined },
          normalizeSourceFailure
        );
  if (resolved.failure) return { failure: resolved.failure };
  if (!resolved.items)
    return {
      failure: OperationFailure.make({
        code: 'SOURCE_UNEXPECTED_FAILURE',
        phase: 'source',
        scope: 'batch',
      }),
    };
  const match = reconcileHistoryEntry(entry, resolved.items);
  if (match.kind === 'missing')
    return {
      failure:
        entry.origin.kind === 'instants'
          ? OperationFailure.make({
              code: 'INSTANT_NOT_ACTIVE',
              phase: 'source',
              scope: 'item',
            })
          : OperationFailure.make({ code: 'MEDIA_NOT_FOUND', phase: 'source', scope: 'item' }),
    };
  if (match.kind === 'ambiguous') return { failure: historyFailure('HISTORY_ITEM_UNRESOLVED') };
  const item = resolved.items.find(candidate => candidate.itemIndex === match.item.itemIndex)!;
  const redownload = {
    itemIndex: item.itemIndex,
    ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    url: item.url,
    filenameHint: item.filenameHint,
    sourceUrl: entry.origin.kind === 'source' ? entry.origin.sourceUrl : '',
    originKind: entry.origin.kind,
    ...(entry.rotation ? { rotation: entry.rotation } : {}),
  };
  if (entry.exportMode === 'frame')
    return {
      frame: { ...redownload, timestampSeconds: entry.frameTimestampSeconds ?? 5 },
      failure: undefined,
    };
  if (entry.exportMode === 'silent') return { silent: redownload, failure: undefined };
  if (entry.rotation)
    return {
      rotated: { ...redownload, mediaType: item.type, rotation: entry.rotation },
      failure: undefined,
    };
  return handleDownloadMedia({
    type: 'DOWNLOAD_MEDIA',
    ...(entry.origin.kind === 'source' ? { sourceUrl: entry.origin.sourceUrl } : {}),
    originKind: entry.origin.kind,
    operations: [
      {
        operationId: createOperationId(),
        requestId: createRequestId(),
        itemIndex: item.itemIndex,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        filename: `${item.filenameHint}_${item.itemIndex + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
        originalUrl: item.url,
        originalFilename: `${item.filenameHint}_${item.itemIndex + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
        mediaType: item.type,
      },
    ],
  });
}

/** Records an export a document downloaded itself, so history holds what the file became. */
async function recordDocumentExport(
  msg: MessageOf<
    | 'RECORD_FRAME_EXPORT'
    | 'DOWNLOAD_FRAME_EXPORT'
    | 'RECORD_SILENT_EXPORT'
    | 'RECORD_DIRECT_EXPORT'
  >,
  exportMode: 'direct' | 'frame' | 'silent'
): Promise<MessageResponse<'RECORD_FRAME_EXPORT'>> {
  const source = msg.originKind === 'instants' ? null : historySource(msg.sourceUrl);
  if (msg.originKind !== 'instants' && !source) return { warning: 'HISTORY_SAVE_FAILED' };
  try {
    await appendAcceptedHistory(
      { ...msg.item, exportMode },
      msg.originKind === 'instants'
        ? { kind: 'instants' }
        : { kind: 'source', sourceUrl: source!.url, sourceKind: source!.kind }
    );
    return {};
  } catch {
    return { warning: 'HISTORY_SAVE_FAILED' };
  }
}

async function handleDownloadFrameExport(
  msg: MessageOf<'DOWNLOAD_FRAME_EXPORT'>
): Promise<MessageResponse<'DOWNLOAD_FRAME_EXPORT'>> {
  try {
    const downloadId = await browser.downloads.download({
      url: msg.dataUrl,
      filename: msg.item.filename,
      saveAs: false,
    });
    if (!(await waitForNonEmptyDownload(downloadId)))
      return {
        failure: OperationFailure.make({
          code: 'BROWSER_DOWNLOAD_FILE_FAILED',
          phase: 'browser-download',
          scope: 'item',
        }),
      };
  } catch (cause) {
    return { failure: normalizeBrowserDownloadFailure(cause) };
  }
  return recordDocumentExport(msg, 'frame');
}

function waitForNonEmptyDownload(downloadId: number): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => settle(false), 10_000);
    const settle = (value: boolean) => {
      clearTimeout(timeout);
      browser.downloads.onChanged.removeListener(listener);
      resolve(value);
    };
    const verify = () =>
      void browser.downloads.search({ id: downloadId }).then(
        items => settle((items[0]?.fileSize ?? 0) > 0),
        () => settle(false)
      );
    const listener = (delta: { id: number; state?: { current?: string } }) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') verify();
      else if (delta.state?.current === 'interrupted') settle(false);
    };
    browser.downloads.onChanged.addListener(listener);
    void browser.downloads.search({ id: downloadId }).then(items => {
      const item = items[0];
      if (item?.state === 'complete') settle((item.fileSize ?? 0) > 0);
      else if (item?.state === 'interrupted') settle(false);
    });
  });
}

async function handleFetchVideoBlob(
  msg: MessageOf<'FETCH_VIDEO_BLOB'>
): Promise<MessageResponse<'FETCH_VIDEO_BLOB'>> {
  return runOperationHandler(
    fetchBlobAsDataUrl(msg.url).pipe(Effect.map(dataUrl => ({ dataUrl }))),
    { dataUrl: undefined },
    normalizeMediaTransferFailure
  );
}

async function handleDebugShape(
  msg: MessageOf<'DEBUG_SHAPE'>
): Promise<MessageResponse<'DEBUG_SHAPE'>> {
  const parsed = parseInstagramUrl(msg.url ?? '');
  if (!parsed || (parsed.type !== 'post' && parsed.type !== 'reel')) {
    return { error: 'Use a post or reel URL for debug' };
  }
  return Effect.runPromise(
    fetchRestShortcodeRaw(parsed.shortcode!).pipe(
      Effect.map(raw => ({ raw })),
      Effect.catchAll(err => Effect.succeed({ error: formatError(err) })),
      Effect.provide(PersonRequests)
    )
  );
}

async function handleDownloadDebugJson(
  msg: MessageOf<'DOWNLOAD_DEBUG_JSON'>
): Promise<MessageResponse<'DOWNLOAD_DEBUG_JSON'>> {
  if (!msg.json) {
    return {
      failure: OperationFailure.make({
        code: 'DOWNLOAD_UNEXPECTED_FAILURE',
        phase: 'browser-download',
        scope: 'item',
      }),
    };
  }
  try {
    // Use jsonToDataUrl — avoids URL.createObjectURL which is unavailable in
    // Chromium MV3 service workers.
    const url = jsonToDataUrl(msg.json);
    await browser.downloads.download({
      url,
      filename: `gramgrab-debug-${Date.now()}.json`,
      saveAs: true,
    });
    return { failure: undefined };
  } catch (cause) {
    return { failure: normalizeBrowserDownloadFailure(cause) };
  }
}

const CONTEXT_MENU_ROOT = 'gramgrab';
const CONTEXT_MENU_OPEN = 'gramgrab-open';
const CONTEXT_MENU_FETCH = 'gramgrab-fetch';

function contextTargetUrl(info: { pageUrl?: string; linkUrl?: string }): string | undefined {
  return canonicalizeInstagramUrl(info.linkUrl ?? info.pageUrl ?? '')?.url;
}

function workspaceCommand(url: string, intent: 'open' | 'fetch'): WorkspaceSnapshot {
  const createdAt = Date.now();
  return {
    version: 4,
    acquisition: { kind: 'source' },
    createdAt,
    expiresAt: createdAt + WORKSPACE_TRANSFER_TTL_MS,
    url,
    fetchedUrl: '',
    status: 'idle',
    message: intent === 'fetch' ? 'Fetching media…' : 'Ready to fetch media.',
    mediaItems: [],
    frameExportSettings: {},
    removeAudioIndexes: [],
    intent,
  };
}

function registerContextMenus(): void {
  void browser.contextMenus
    .removeAll()
    .then(() => {
      browser.contextMenus.create({
        id: CONTEXT_MENU_ROOT,
        title: 'GramGrab',
        contexts: ['page', 'link'],
        // Keep a safe visible fallback for browsers that do not expose onShown.
        // The click handler still validates the target before doing any work.
        visible: true,
      });
      browser.contextMenus.create({
        id: CONTEXT_MENU_OPEN,
        parentId: CONTEXT_MENU_ROOT,
        title: 'Open in GramGrab',
        contexts: ['page', 'link'],
      });
      browser.contextMenus.create({
        id: CONTEXT_MENU_FETCH,
        parentId: CONTEXT_MENU_ROOT,
        title: 'Fetch with GramGrab',
        contexts: ['page', 'link'],
      });
    })
    .catch(err => console.warn('Could not register GramGrab context menus:', err));
}

browser.contextMenus.onShown.addListener(info => {
  void browser.contextMenus
    .update(CONTEXT_MENU_ROOT, { visible: Boolean(contextTargetUrl(info)) })
    .then(() => browser.contextMenus.refresh())
    .catch(err => console.warn('Could not update GramGrab context menu visibility:', err));
});

browser.contextMenus.onClicked.addListener(info => {
  const url = contextTargetUrl(info);
  if (!url) return;
  const intent = info.menuItemId === CONTEXT_MENU_FETCH ? 'fetch' : 'open';
  if (info.menuItemId !== CONTEXT_MENU_OPEN && info.menuItemId !== CONTEXT_MENU_FETCH) return;
  void replaceWorkspace(workspaceCommand(url, intent)).catch(err =>
    console.warn('Could not open GramGrab workspace from context menu:', err)
  );
});

registerContextMenus();

let runnerTabId: number | undefined;
let runnerWindowId: number | undefined;
let runnerReady: Promise<number> | undefined;
let resolveRunnerReady: ((tabId: number) => void) | undefined;
let runnerProgress: ((event: Progress) => void) | undefined;
let runnerIdleTimer: ReturnType<typeof setTimeout> | undefined;
let exportQueue: Promise<void> = Promise.resolve();

function cancellationError(): Error {
  return new Error('Request cancelled.');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancellationError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function discardRunner(): void {
  const tabId = runnerTabId;
  const windowId = runnerWindowId;
  runnerTabId = undefined;
  runnerWindowId = undefined;
  runnerReady = undefined;
  resolveRunnerReady = undefined;
  if (windowId !== undefined) void browser.windows.remove(windowId).catch(() => undefined);
  else if (tabId !== undefined) void browser.tabs.remove(tabId).catch(() => undefined);
}

async function getRunner(): Promise<number> {
  if (!runnerReady) {
    runnerReady = new Promise(resolve => {
      resolveRunnerReady = resolve;
    });
    const runnerWindow = await browser.windows.create({
      url: browser.runtime.getURL('runner.html'),
      focused: false,
      state: 'minimized',
      type: 'popup',
    });
    runnerWindowId = runnerWindow.id;
    runnerTabId = runnerWindow.tabs?.[0]?.id;
  }
  return Promise.race([
    runnerReady,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The extension runner did not become ready.')), 5_000)
    ),
  ]);
}

type ProtocolExportCommand = ProtocolExport | ProtocolInstantsExport;

async function runInDocument(command: ProtocolExportCommand) {
  const tabId = await getRunner();
  return sendTabMessage(tabId, {
    type: 'RUN_EXPORT',
    sourceUrl: command._tag === 'Export' ? command.sourceUrl : '',
    originKind: command._tag === 'InstantsExport' ? 'instants' : 'source',
    command,
  });
}

async function runPreparedInDocument(
  request: Omit<MessageOf<'RUN_EXPORT'>, 'type'>
): Promise<ProtocolExportResult> {
  let release = () => {};
  const turn = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = exportQueue;
  exportQueue = previous.then(() => turn);
  await previous;
  try {
    const tabId = await getRunner();
    return Schema.decodeUnknownSync(ProtocolExportResult)(
      await sendTabMessage(tabId, { type: 'RUN_EXPORT', ...request })
    );
  } finally {
    release();
    discardRunner();
  }
}

function protocolFailure(failure: OperationFailure): ProtocolOperationFailure {
  return ProtocolOperationFailure.make({ code: failure.code, scope: failure.scope });
}

async function inspectCommand(sourceUrl: string): Promise<InspectResult> {
  const response = await handleFetchMedia({ type: 'FETCH_MEDIA', url: sourceUrl });
  if (response.failure) throw protocolFailure(response.failure);
  if (!response.media || !response.sourceUrl)
    throw ProtocolOperationFailure.make({ code: 'SOURCE_MEDIA_NOT_FOUND', scope: 'batch' });
  return InspectResult.make({
    sourceUrl: response.sourceUrl,
    items: response.media.map((item, index) =>
      InspectedMedia.make({
        itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(index + 1),
        mediaIdentity: MediaIdentity.make({
          itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(item.itemIndex),
          ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        }),
        mediaType: item.type === 'video' ? 'video' : 'image',
        url: item.url,
        ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
        filenameHint: item.filenameHint,
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        ...(item.history ? { history: ProtocolHistoryMarker.make(item.history) } : {}),
      })
    ),
  });
}

async function inspectInstantsCommand(): Promise<InstantsInspectResult> {
  const response = await handleFetchInstants({ type: 'FETCH_INSTANTS' });
  if (response.failure) throw protocolFailure(response.failure);
  if (!response.media)
    throw ProtocolOperationFailure.make({ code: 'SOURCE_MEDIA_NOT_FOUND', scope: 'batch' });
  return InstantsInspectResult.make({
    items: response.media.map((item, index) =>
      InspectedMedia.make({
        itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(index + 1),
        mediaIdentity: MediaIdentity.make({
          itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(item.itemIndex),
          ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        }),
        mediaType: item.type === 'video' ? 'video' : 'image',
        url: item.url,
        ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
        filenameHint: item.filenameHint,
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        ...(item.creatorUsername ? { creatorUsername: item.creatorUsername } : {}),
        ...(item.history ? { history: ProtocolHistoryMarker.make(item.history) } : {}),
      })
    ),
  });
}

function historyEntry(entry: DownloadHistoryEntry): ProtocolHistoryEntry {
  return ProtocolHistoryEntry.make({
    id: entry.id,
    origin: entry.origin,
    mediaIdentity: MediaIdentity.make({
      itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(entry.itemIndex),
      ...(entry.mediaId ? { mediaId: entry.mediaId } : {}),
    }),
    mediaType: entry.mediaType,
    filenameHint: entry.filenameHint,
    ...(entry.exportMode ? { exportMode: entry.exportMode } : {}),
    ...(entry.rotation ? { rotation: entry.rotation } : {}),
    ...(entry.requestedExport ? { requestedExport: entry.requestedExport } : {}),
    ...(entry.recovery ? { recovery: entry.recovery } : {}),
    ...(entry.frameTimestampSeconds === undefined
      ? {}
      : { frameTimestampSeconds: entry.frameTimestampSeconds }),
    downloadedAt: entry.downloadedAt,
  });
}

async function runExport(
  command: ProtocolExportCommand,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
) {
  if (
    command.operations.every(
      operation => operation.mode._tag === 'DirectExport' && operation.rotation === undefined
    )
  )
    return runDirectExport(command, emit, signal);
  let release = () => {};
  const turn = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = exportQueue;
  exportQueue = previous.then(() => turn);
  const abort = () => discardRunner();
  try {
    await abortable(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  try {
    if (runnerIdleTimer) clearTimeout(runnerIdleTimer);
    runnerIdleTimer = undefined;
    runnerProgress = emit;
    signal.addEventListener('abort', abort, { once: true });
    try {
      return Schema.decodeUnknownSync(CommandResult)(
        await abortable(runInDocument(command), signal)
      );
    } catch {
      if (signal.aborted) throw cancellationError();
      const staleTabId = runnerTabId;
      runnerTabId = undefined;
      runnerReady = undefined;
      if (staleTabId !== undefined) discardRunner();
      return Schema.decodeUnknownSync(CommandResult)(
        await abortable(runInDocument(command), signal)
      );
    }
  } finally {
    signal.removeEventListener('abort', abort);
    runnerProgress = undefined;
    release();
    discardRunner();
  }
}

// fallow-ignore-next-line complexity
async function runDirectExport(
  command: ProtocolExportCommand,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
) {
  const inspected =
    command._tag === 'InstantsExport'
      ? await abortable(inspectInstantsCommand(), signal)
      : await abortable(inspectCommand(command.sourceUrl), signal);
  const operations: DownloadOperation[] = [];
  for (const requested of command.operations) {
    const requestedMediaId = requested.mediaIdentity?.mediaId;
    const matches = requestedMediaId
      ? inspected.items.filter(item => item.mediaIdentity.mediaId === requestedMediaId)
      : [];
    const item = requestedMediaId
      ? matches.length === 1
        ? matches[0]
        : undefined
      : inspected.items[requested.itemNumber - 1];
    if (
      !item ||
      (requested.mediaIdentity &&
        !requestedMediaId &&
        requested.mediaIdentity.itemIndex !== item.mediaIdentity.itemIndex)
    )
      continue;
    emit(
      Progress.make({
        operationId: requested.operationId,
        itemNumber: requested.itemNumber,
        phase: 'direct-download',
      })
    );
    const extension = item.mediaType === 'video' ? 'mp4' : 'jpg';
    operations.push({
      operationId: requested.operationId,
      requestId: createRequestId(),
      itemIndex: item.mediaIdentity.itemIndex,
      ...(item.mediaIdentity.mediaId ? { mediaId: item.mediaIdentity.mediaId } : {}),
      url: item.url,
      filename: `${item.filenameHint}_${item.mediaIdentity.itemIndex + 1}.${extension}`,
      originalUrl: item.url,
      originalFilename: `${item.filenameHint}_${item.mediaIdentity.itemIndex + 1}.${extension}`,
      mediaType: item.mediaType,
    });
  }
  if (signal.aborted) throw cancellationError();
  const response = await handleDownloadMedia({
    type: 'DOWNLOAD_MEDIA',
    ...(command._tag === 'Export' ? { sourceUrl: command.sourceUrl } : {}),
    originKind: command._tag === 'InstantsExport' ? 'instants' : 'source',
    operations,
  });
  const batchFailure = response.failure;
  const results = batchFailure
    ? operations.map(operation =>
        DownloadFailedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'failed',
          failure: batchFailure,
        })
      )
    : response.results;
  return ProtocolExportResult.make({
    outcomes: command.operations.map(requested => {
      const result = results.find(candidate => candidate.operationId === requested.operationId);
      const identity =
        requested.mediaIdentity ??
        MediaIdentity.make({
          itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(requested.itemNumber - 1),
        });
      return result?.status === 'started'
        ? ItemSucceeded.make({
            operationId: requested.operationId,
            itemNumber: requested.itemNumber,
            mediaIdentity: identity,
          })
        : ItemFailed.make({
            operationId: requested.operationId,
            itemNumber: requested.itemNumber,
            mediaIdentity: identity,
            failure:
              result?.status === 'failed'
                ? protocolFailure(result.failure)
                : ProtocolOperationFailure.make({ code: 'MEDIA_NOT_FOUND', scope: 'item' }),
          });
    }),
  });
}

// fallow-ignore-next-line complexity
async function executeCommand(
  request: Request,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
): Promise<void> {
  try {
    const command = request.command;
    let result: CommandResult;
    switch (command._tag) {
      case 'Inspect':
        emit(Progress.make({ phase: 'resolving' }));
        result = await abortable(inspectCommand(command.sourceUrl), signal);
        break;
      case 'InstantsInspect':
        emit(Progress.make({ phase: 'resolving' }));
        result = await abortable(inspectInstantsCommand(), signal);
        break;
      case 'Export':
        emit(Progress.make({ phase: 'resolving' }));
        result = await runExport(command, emit, signal);
        break;
      case 'InstantsExport':
        emit(Progress.make({ phase: 'resolving' }));
        result = await runExport(command, emit, signal);
        break;
      case 'HistoryList': {
        emit(Progress.make({ phase: 'history' }));
        const history = await abortable(getHistory(), signal);
        if (history.kind === 'unknown-version') throw new Error('Unsupported history version.');
        result = HistoryListResult.make({
          entries: history.entries
            .filter((entry): entry is DownloadHistoryEntry => 'id' in entry)
            .reverse()
            .map(historyEntry),
          repaired: history.repaired,
        });
        break;
      }
      case 'HistoryRemove': {
        const before = await abortable(getHistory(), signal);
        if (before.kind === 'unknown-version') throw new Error('Unsupported history version.');
        const instagramEntries = before.entries.filter(
          (entry): entry is DownloadHistoryEntry => 'id' in entry
        );
        const known = new Set(instagramEntries.map(entry => entry.id));
        const removedEntryIds = command.entryIds.filter(id => known.has(id));
        if (removedEntryIds.length > 0)
          await abortable(removeHistoryEntries(removedEntryIds), signal);
        result = HistoryRemoveResult.make({
          removedEntryIds,
          unknownEntryIds: command.entryIds.filter(id => !known.has(id)),
        });
        break;
      }
      case 'HistoryClear': {
        const before = await abortable(getHistory(), signal);
        if (before.kind === 'unknown-version') throw new Error('Unsupported history version.');
        await abortable(clearHistory(), signal);
        result = HistoryClearResult.make({ clearedCount: before.entries.length });
        break;
      }
      case 'HistoryRedownload': {
        const before = await abortable(getHistory(), signal);
        if (before.kind === 'unknown-version') throw new Error('Unsupported history version.');
        const instagramEntries = before.entries.filter(
          (entry): entry is DownloadHistoryEntry => 'id' in entry
        );
        const known = new Set(instagramEntries.map(entry => entry.id));
        const outcomes = [];
        for (const entryId of command.entryIds.filter(id => known.has(id))) {
          signal.throwIfAborted();
          const entry = instagramEntries.find(candidate => candidate.id === entryId);
          const response = await abortable(
            handleRedownloadHistoryEntry({ type: 'REDOWNLOAD_HISTORY_ENTRY', entryId }),
            signal
          );
          const frame = 'frame' in response ? response.frame : undefined;
          const silent = 'silent' in response ? response.silent : undefined;
          const rotated = 'rotated' in response ? response.rotated : undefined;
          const resolvedItem = frame ?? silent ?? rotated;
          if (entry && resolvedItem) {
            const operations = [
              ProtocolExportOperation.make({
                operationId: Schema.decodeUnknownSync(ProtocolOperationId)(crypto.randomUUID()),
                itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(resolvedItem.itemIndex + 1),
                mediaIdentity: MediaIdentity.make({
                  itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(resolvedItem.itemIndex),
                  ...(resolvedItem.mediaId ? { mediaId: resolvedItem.mediaId } : {}),
                }),
                mode: frame
                  ? FrameExport.make({ timestampSeconds: frame.timestampSeconds })
                  : silent
                    ? SilentExport.make({ reencode: 'allow' })
                    : DirectExport.make(),
                ...(resolvedItem.rotation ? { rotation: resolvedItem.rotation } : {}),
              }),
            ];
            const historyExport =
              entry.origin.kind === 'instants'
                ? ProtocolInstantsExport.make({ operations })
                : ProtocolExport.make({ sourceUrl: entry.origin.sourceUrl, operations });
            const exportResult = await runExport(historyExport, emit, signal);
            const failed =
              exportResult._tag === 'ExportResult' &&
              exportResult.outcomes.some(outcome => outcome._tag !== 'ItemSucceeded');
            outcomes.push(
              failed
                ? HistoryRedownloadFailed.make({
                    entryId,
                    failure: ProtocolOperationFailure.make({
                      code: 'DOWNLOAD_UNEXPECTED_FAILURE',
                      scope: 'item',
                    }),
                  })
                : HistoryRedownloadStarted.make({ entryId })
            );
            continue;
          }
          const failure = response.failure;
          const directFailed =
            'results' in response && response.results.some(result => result.status !== 'started');
          outcomes.push(
            failure || directFailed
              ? HistoryRedownloadFailed.make({
                  entryId,
                  failure: ProtocolOperationFailure.make({
                    code: failure?.code ?? 'MEDIA_NOT_FOUND',
                    scope: 'item',
                  }),
                })
              : HistoryRedownloadStarted.make({ entryId })
          );
        }
        result = HistoryRedownloadResult.make({
          outcomes,
          unknownEntryIds: command.entryIds.filter(id => !known.has(id)),
        });
        break;
      }
      case 'DebugGet': {
        signal.throwIfAborted();
        emit(Progress.make({ phase: 'diagnostics' }));
        result = DebugGetResult.make({
          diagnosticsVersion: 2,
          report: buildDiagnostics({
            extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
            userAgent: globalThis.navigator?.userAgent ?? '',
          }),
        });
        break;
      }
      case 'DebugExport': {
        signal.throwIfAborted();
        const filename = `gramgrab-debug-${Date.now()}.json`;
        const report = buildDiagnostics({
          extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
          userAgent: globalThis.navigator?.userAgent ?? '',
        });
        await browser.downloads.download({
          url: jsonToDataUrl(JSON.parse(report)),
          filename,
          saveAs: true,
        });
        result = DebugExportResult.make({
          diagnosticsVersion: 2,
          filename,
          status: 'started',
        });
        break;
      }
      case 'WatchList':
      case 'WatchShow':
      case 'WatchAdd':
      case 'WatchSet':
      case 'WatchLifecycle':
      case 'WatchCheck':
      case 'WatchNeeds':
      case 'WatchAttentionRecover':
      case 'WatchRecover':
      case 'WatchInboxList':
      case 'WatchInboxRemove':
      case 'WatchInboxExport':
      case 'WatchInboxRetry': {
        emit(Progress.make({ phase: 'resolving' }));
        const outcome = await abortable(
          runWatchCommand(command, runPreparedInDocument, watchCheck =>
            emit(Progress.make({ phase: 'watch-check', watchCheck }))
          ),
          signal
        );
        if (outcome.failure) {
          emit(Rejected.make({ failure: outcome.failure }));
          return;
        }
        result = outcome.result;
        break;
      }
      default:
        throw new Error('Unsupported command.');
    }
    emit(Completed.make({ result }));
  } catch (error) {
    emit(
      Rejected.make({
        failure:
          error instanceof ProtocolOperationFailure
            ? CommandFailure.make({ failure: error })
            : validationFailureFrom(error),
      })
    );
  }
}

startNativeBridge(executeCommand);
browser.runtime.onStartup.addListener(() => startNativeBridge(executeCommand));

// Watches: one periodic alarm wakes the worker to run due checks. Each wake, browser start, and
// installation recreates the alarm if the browser dropped it.
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM_NAME) return;
  void ensureAlarm();
  void pump();
});
browser.runtime.onStartup.addListener(() => void holdForStartup().then(ensureAlarm));
browser.runtime.onInstalled.addListener(() => void ensureAlarm());
// A Watch notification opens that Watch's Inbox tab; the page shows it only to its own login.
browser.notifications.onClicked.addListener(id => {
  const watchId = notifiedWatch(id);
  if (!watchId) return;
  void browser.notifications.clear(id).catch(() => undefined);
  void browser.tabs.create({ url: browser.runtime.getURL(`options.html#watch=${watchId}`) });
});
void initializeScheduler().catch(() => undefined);
void refreshBadge();

// ---------------------------------------------------------------------------
// Single message dispatcher
//
// All listeners are registered synchronously at module top-level so they are
// available immediately when the service worker starts.
//
// We use `sendResponse` + `return true` instead of returning a Promise from
// the listener. This is the cross-browser-safe pattern: Chrome's MV3 docs
// still recommend it, and Firefox supports it alongside promise-return style.
// ---------------------------------------------------------------------------

type MessageHandlers = {
  readonly [T in BackgroundMessageType]: (message: MessageOf<T>) => Promise<MessageResponse<T>>;
};

const messageHandlers: MessageHandlers = {
  FETCH_MEDIA: handleFetchMedia,
  FETCH_INSTANTS: handleFetchInstants,
  GET_PREVIEW_URL: handleGetPreviewUrl,
  DOWNLOAD_MEDIA: handleDownloadMedia,
  GET_DOWNLOAD_HISTORY: handleGetDownloadHistory,
  RECORD_WHATSAPP_HISTORY: handleRecordWhatsAppHistory,
  DELETE_WHATSAPP_HISTORY_RECEIPT: handleDeleteWhatsAppHistoryReceipt,
  DELETE_HISTORY_ENTRY: async message => {
    try {
      const entries = await removeHistoryEntries([message.entryId]);
      return { entries: [...entries].reverse(), failure: undefined };
    } catch {
      return { entries: [], failure: historyFailure('HISTORY_STORE_FAILED') };
    }
  },
  CLEAR_DOWNLOAD_HISTORY: async () => {
    try {
      await clearHistory();
      return { failure: undefined };
    } catch {
      return { failure: historyFailure('HISTORY_STORE_FAILED') };
    }
  },
  REDOWNLOAD_HISTORY_ENTRY: handleRedownloadHistoryEntry,
  RECORD_FRAME_EXPORT: message => recordDocumentExport(message, 'frame'),
  DOWNLOAD_FRAME_EXPORT: handleDownloadFrameExport,
  RECORD_SILENT_EXPORT: message => recordDocumentExport(message, 'silent'),
  RECORD_DIRECT_EXPORT: message => recordDocumentExport(message, 'direct'),
  FETCH_VIDEO_BLOB: handleFetchVideoBlob,
  DEBUG_SHAPE: handleDebugShape,
  DOWNLOAD_DEBUG_JSON: handleDownloadDebugJson,
  WATCH_COMMAND: message => runWatchCommand(message.command, runPreparedInDocument),
  WATCH_READ: message => runWatchRead(message.command, message.viewer),
  WATCH_PREVIEW: message => previewWatchTarget(message.target),
  WATCH_AVATARS: message => watchAvatars(message.viewerId),
  WATCH_INBOX_PREVIEW: message => previewInboxEntry(message.entryId),
};

/** Indexing the handler map with a type parameter keeps the request and its response correlated. */
function answer<T extends BackgroundMessageType>(
  type: T,
  message: MessageOf<T>
): Promise<MessageResponse<T>> {
  return messageHandlers[type](message);
}

const RUNNER_PHASES: Record<string, Progress['phase']> = {
  'direct-download': 'direct-download',
  'frame-metadata': 'frame-metadata',
  'frame-export': 'frame-export',
  queued: 'silent-inspection',
  inspecting: 'silent-inspection',
  copying: 'silent-copy',
  reencoding: 'silent-reencode',
  validating: 'silent-validation',
  downloading: 'silent-validation',
};

function isAnswerable(type: MessageType): type is BackgroundMessageType {
  return type in messageHandlers;
}

function acceptRunnerReady(senderTabId: number | undefined): false {
  if (senderTabId === undefined) return false;
  runnerTabId = senderTabId;
  resolveRunnerReady?.(senderTabId);
  resolveRunnerReady = undefined;
  return false;
}

function acceptRunnerProgress(message: MessageOf<'RUNNER_PROGRESS'>): false {
  runnerProgress?.(
    Progress.make({
      ...(message.operationId ? { operationId: message.operationId } : {}),
      ...(message.itemNumber ? { itemNumber: message.itemNumber } : {}),
      phase: RUNNER_PHASES[message.phase] ?? 'silent-inspection',
      ...(message.progress === undefined ? {} : { progress: message.progress }),
    })
  );
  return false;
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const decoded = decodeMessage(msg);
  if (decoded.kind === 'foreign') return false;
  if (decoded.kind === 'unsupported') {
    if (isAnswerable(decoded.type)) sendResponse(MESSAGE_REFUSALS[decoded.type]());
    return false;
  }
  const message = decoded.message;
  // RUN_EXPORT belongs to the runner document, and the runner's notifications are absorbed into
  // worker state rather than answered.
  if (message.type === 'RUN_EXPORT') return false;
  if (message.type === 'RUNNER_READY') return acceptRunnerReady(sender.tab?.id);
  if (message.type === 'RUNNER_PROGRESS') return acceptRunnerProgress(message);
  void answer(message.type, message).then(sendResponse);
  return true;
});
