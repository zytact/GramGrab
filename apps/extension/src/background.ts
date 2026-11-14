import { Either, Effect, Option, Schema } from 'effect';
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
  HistoryListResult,
  HistoryMarker as ProtocolHistoryMarker,
  HistoryRedownload,
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
  type InstagramLogin,
  deliversOriginal,
  type ExportModeKind,
  type ExportSettings,
  type Inspect,
  type InstantsInspect,
  type MediaItem as ProtocolMediaItem,
  type MediaType,
  type ProgressPhase,
} from '@gramgrab/protocol';
import {
  canonicalizeInstagramUrl,
  WORKSPACE_TRANSFER_TTL_MS,
  type WorkspaceSnapshot,
} from './workspace/contracts.ts';
import { replaceWorkspace } from './workspace/coordinator.ts';
import { isPositiveFinite } from './workspace/media-ratio.ts';
import { protocolHistoryEntry } from './history/protocol.ts';
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
  type HistoryEntry,
  type HistoryMarker,
  type HistoryOrigin,
} from './history/contracts.ts';
import { jsonToDataUrl } from './lib/data-url.ts';
import { fetchInstantMedia, resolveMediaEffect } from './instagram/acquisition.ts';
import { runOperationHandler } from './effect/runtime.ts';
import { fetchBlobAsDataUrl } from './effect/instagram.ts';
import { isAvatarMediaId, type MediaItem } from './instagram/normalize.ts';
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadMediaResponse,
  createOperationId,
  createRequestId,
  type DownloadOperation,
  type OperationId,
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
import { OperationFailure, OperationWarning, watchFailure } from './errors/contracts.ts';
import { listenForLinkedCookies, restoreLinkedRule } from './instagram/linked-login.ts';
import { linkLogin, loginNames, unlinkLinkedLogin } from './instagram/link.ts';
import { installInstagramOrigin } from './instagram/origin.ts';
import {
  previewInboxEntry,
  restoreInboxEntries,
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
  retryAfterUpdate,
} from './watch/scheduler.ts';
import { notifiedWatch } from './watch/notify.ts';
import { recordFetched } from './watch/fetched.ts';
import { acceptedHistoryEntry } from './history/receipt.ts';
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
  const queue = items.entries();
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (const [index, item] of queue) results[index] = await mapper(item, index);
    })
  );
  return results;
}

// ---------------------------------------------------------------------------
// Handler functions. Each returns a structured response value.
// ---------------------------------------------------------------------------

function hasValidMediaDimensions(
  item: MediaItem
): item is MediaItem & { width: number; height: number } {
  return isPositiveFinite(item.width) && isPositiveFinite(item.height);
}

/** Instagram download receipts, leaving out WhatsApp receipts. */
function instagramEntries(entries: readonly HistoryEntry[]): DownloadHistoryEntry[] {
  return entries.filter((entry): entry is DownloadHistoryEntry => 'id' in entry);
}

/** The History origin of an Instagram Source URL, or null when the URL is not one. */
function sourceOrigin(url: string): Extract<HistoryOrigin, { kind: 'source' }> | null {
  const source = historySource(url);
  return source && { kind: 'source', sourceUrl: source.url, sourceKind: source.kind };
}

const invalidSourceUrl = () =>
  OperationFailure.make({ code: 'INPUT_INVALID_SOURCE_URL', phase: 'input', scope: 'batch' });

/**
 * Resolves what an origin holds now as `login`, after marking the items seen by that login's
 * Watches of the accounts that posted them.
 */
function resolveItems(origin: HistoryOrigin, login: InstagramLogin | undefined) {
  return runOperationHandler(
    Effect.gen(function* () {
      const { items, fetched } = yield* origin.kind === 'instants'
        ? fetchInstantMedia()
        : resolveMediaEffect(origin.sourceUrl);
      yield* recordFetched(fetched);
      return { items };
    }),
    {},
    normalizeSourceFailure,
    login
  );
}

/** An origin's items as the popup receives them, each marked with its History. */
async function mediaWithHistory(
  origin: HistoryOrigin,
  login: InstagramLogin | undefined
): Promise<{ media: ProtocolMediaItem[]; failure?: never } | { failure: OperationFailure }> {
  const resolved = await resolveItems(origin, login);
  if (resolved.failure) return { failure: resolved.failure };
  const stored = await getHistory();
  if (stored.kind === 'unknown-version')
    return { failure: historyFailure('HISTORY_VERSION_UNSUPPORTED') };
  const history = instagramEntries(stored.entries);
  return {
    media: resolved.items.map(item => ({
      url: item.url,
      itemIndex: item.itemIndex,
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      type: item.type,
      filenameHint: item.filenameHint,
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
      history: historyMarker(history, origin, item),
      ...(hasValidMediaDimensions(item) ? { width: item.width, height: item.height } : {}),
      ...(item.creatorUsername ? { creatorUsername: item.creatorUsername } : {}),
      ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
    })),
  };
}

async function handleFetchMedia(
  msg: MessageOf<'FETCH_MEDIA'>
): Promise<MessageResponse<'FETCH_MEDIA'>> {
  const origin = sourceOrigin(msg.url);
  if (!origin) return { failure: invalidSourceUrl() };
  const result = await mediaWithHistory(origin, msg.login);
  return result.failure ? result : { sourceUrl: origin.sourceUrl, media: result.media };
}

async function handleFetchInstants(
  msg: MessageOf<'FETCH_INSTANTS'>
): Promise<MessageResponse<'FETCH_INSTANTS'>> {
  const result = await mediaWithHistory({ kind: 'instants' }, msg.login);
  return result.failure ? result : { acquisition: 'instants', media: result.media };
}

const sameOrigin = (a: HistoryOrigin, b: HistoryOrigin) =>
  a.kind === 'instants'
    ? b.kind === 'instants'
    : b.kind === 'source' && a.sourceUrl === b.sourceUrl;

function historyMarker(
  entries: readonly DownloadHistoryEntry[],
  origin: HistoryOrigin,
  item: MediaItem
): HistoryMarker {
  const matches = entries.filter(
    entry =>
      sameOrigin(entry.origin, origin) && reconcileHistoryEntry(entry, [item]).kind === 'found'
  );
  const latest = matches.reduce<number | undefined>(
    (value, entry) =>
      value === undefined || entry.downloadedAt > value ? entry.downloadedAt : value,
    undefined
  );
  return {
    downloaded: matches.length > 0,
    count: matches.length,
    ...(latest === undefined ? {} : { latestDownloadedAt: latest }),
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

/**
 * One history write covers a whole download batch. A failed write warns every entry it would have
 * held, so an item still reports its own history outcome.
 */
async function recordAcceptedHistory(
  attempts: readonly DownloadAttempt[],
  origin: HistoryOrigin
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
  const source = request.sourceUrl ? sourceOrigin(request.sourceUrl) : undefined;
  if (source === null)
    return DownloadMediaResponse.make({ results: [], failure: invalidSourceUrl() });
  const origin: HistoryOrigin | undefined =
    request.originKind === 'instants' ? { kind: 'instants' } : source;
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

/** History newest first after `change` writes it, or HISTORY_STORE_FAILED when the write throws. */
async function historyAfter(
  change: () => Promise<readonly HistoryEntry[]>
): Promise<MessageResponse<'DELETE_HISTORY_ENTRY'>> {
  try {
    const entries = await change();
    return { entries: [...entries].reverse(), failure: undefined };
  } catch {
    return { entries: [], failure: historyFailure('HISTORY_STORE_FAILED') };
  }
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
  return historyAfter(() => removeWhatsAppHistoryReceipt(receipt.right));
}

/** Why a receipt's recorded media is no longer among what its source returns. */
function missingFailure(entry: DownloadHistoryEntry): OperationFailure {
  if (entry.origin.kind === 'instants')
    return OperationFailure.make({ code: 'INSTANT_NOT_ACTIVE', phase: 'source', scope: 'item' });
  if (entry.mediaId && isAvatarMediaId(entry.mediaId))
    return watchFailure('WATCH_AVATAR_CHANGED', 'avatar');
  return OperationFailure.make({ code: 'MEDIA_NOT_FOUND', phase: 'source', scope: 'item' });
}

async function findHistoryEntry(
  entryId: string
): Promise<{ entry: DownloadHistoryEntry; failure?: never } | { failure: OperationFailure }> {
  const history = await getHistory();
  if (history.kind === 'unknown-version')
    return { failure: historyFailure('HISTORY_VERSION_UNSUPPORTED') };
  const entry = instagramEntries(history.entries).find(candidate => candidate.id === entryId);
  return entry ? { entry } : { failure: historyFailure('HISTORY_ENTRY_NOT_FOUND') };
}

/** Finds the item an entry's source returns for it now. */
async function resolveHistoryItem(
  entry: DownloadHistoryEntry,
  login: InstagramLogin | undefined
): Promise<{ item: MediaItem; failure?: never } | { failure: OperationFailure }> {
  const resolved = await resolveItems(entry.origin, login);
  if (resolved.failure) return { failure: resolved.failure };
  const match = reconcileHistoryEntry(entry, resolved.items);
  if (match.kind === 'missing') return { failure: missingFailure(entry) };
  if (match.kind === 'ambiguous') return { failure: historyFailure('HISTORY_ITEM_UNRESOLVED') };
  return { item: match.item };
}

/** The export settings a re-download reproduces, derived from the entry's mode, rotation and crop. */
function historySettings(entry: DownloadHistoryEntry): ExportSettings {
  return {
    mode:
      entry.exportMode === 'frame'
        ? FrameExport.make({ timestampSeconds: entry.frameTimestampSeconds ?? 5 })
        : entry.exportMode === 'silent'
          ? SilentExport.make({ reencode: 'allow' })
          : DirectExport.make(),
    ...(entry.rotation ? { rotation: entry.rotation } : {}),
    ...(entry.crop ? { crop: entry.crop } : {}),
  };
}

function needsRunner(entry: DownloadHistoryEntry): boolean {
  return !deliversOriginal(historySettings(entry));
}

/** The operation that downloads one item exactly as Instagram serves it. */
function originalDownload(
  operationId: OperationId,
  item: {
    readonly itemIndex: number;
    readonly mediaId?: string | undefined;
    readonly url: string;
    readonly filenameHint: string;
    readonly mediaType: MediaType;
  }
): DownloadOperation {
  const filename = `${item.filenameHint}_${item.itemIndex + 1}.${item.mediaType === 'video' ? 'mp4' : 'jpg'}`;
  return {
    operationId,
    requestId: createRequestId(),
    itemIndex: item.itemIndex,
    ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    url: item.url,
    filename,
    originalUrl: item.url,
    originalFilename: filename,
    mediaType: item.mediaType,
  };
}

function downloadHistoryOriginal(entry: DownloadHistoryEntry, item: MediaItem) {
  return handleDownloadMedia({
    type: 'DOWNLOAD_MEDIA',
    ...(entry.origin.kind === 'source' ? { sourceUrl: entry.origin.sourceUrl } : {}),
    originKind: entry.origin.kind,
    operations: [originalDownload(createOperationId(), { ...item, mediaType: item.type })],
  });
}

function redownloadTarget(entry: DownloadHistoryEntry, item: MediaItem) {
  return {
    itemIndex: item.itemIndex,
    ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    url: item.url,
    filenameHint: item.filenameHint,
    sourceUrl: entry.origin.kind === 'source' ? entry.origin.sourceUrl : '',
    originKind: entry.origin.kind,
    ...(entry.rotation ? { rotation: entry.rotation } : {}),
    ...(entry.crop ? { crop: entry.crop } : {}),
  };
}

async function handleRedownloadHistoryEntry(
  msg: MessageOf<'REDOWNLOAD_HISTORY_ENTRY'>
): Promise<MessageResponse<'REDOWNLOAD_HISTORY_ENTRY'>> {
  const found = await findHistoryEntry(msg.entryId);
  if (found.failure) return { failure: found.failure };
  const { entry } = found;
  const resolved = await resolveHistoryItem(entry, msg.login);
  if (resolved.failure) return { failure: resolved.failure };
  const { item } = resolved;
  const settings = historySettings(entry);
  if (deliversOriginal(settings)) return downloadHistoryOriginal(entry, item);
  const { mode } = settings;
  const redownload = redownloadTarget(entry, item);
  if (mode._tag === 'FrameExport')
    return {
      frame: { ...redownload, timestampSeconds: mode.timestampSeconds },
      failure: undefined,
    };
  if (mode._tag === 'SilentExport') return { silent: redownload, failure: undefined };
  return { modified: { ...redownload, mediaType: item.type }, failure: undefined };
}

/** Records an export a document downloaded itself, so history holds what the file became. */
async function recordDocumentExport(
  msg: MessageOf<'DOWNLOAD_FRAME_EXPORT' | 'RECORD_SILENT_EXPORT' | 'RECORD_DIRECT_EXPORT'>,
  exportMode: ExportModeKind
): Promise<MessageResponse<'DOWNLOAD_FRAME_EXPORT'>> {
  const origin: HistoryOrigin | null =
    msg.originKind === 'instants' ? { kind: 'instants' } : sourceOrigin(msg.sourceUrl);
  if (!origin) return { warning: 'HISTORY_SAVE_FAILED' };
  try {
    await appendHistory(acceptedHistoryEntry({ ...msg.item, exportMode }, origin));
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

/**
 * Gives `use` the runner document to itself for one whole operation, however many exports it sends,
 * then closes the runner. Aborting `signal` closes the runner at once.
 */
async function withRunner<T>(signal: AbortSignal, use: () => Promise<T>): Promise<T> {
  let release = () => {};
  const turn = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = exportQueue;
  exportQueue = previous.then(() => turn);
  try {
    await abortable(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  signal.addEventListener('abort', discardRunner, { once: true });
  try {
    return await use();
  } finally {
    signal.removeEventListener('abort', discardRunner);
    release();
    discardRunner();
  }
}

async function runPreparedInDocument(
  request: Omit<MessageOf<'RUN_EXPORT'>, 'type'>
): Promise<ProtocolExportResult> {
  return withRunner(new AbortController().signal, async () =>
    Schema.decodeUnknownSync(ProtocolExportResult)(
      await sendTabMessage(await getRunner(), { type: 'RUN_EXPORT', ...request })
    )
  );
}

/** Sends one export to the runner, retrying once in a fresh runner. Call it inside `withRunner`. */
async function exportInRunner(
  command: ProtocolExportCommand,
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
  login: InstagramLogin | undefined,
  preparedMedia?: readonly MediaItem[]
): Promise<CommandResult> {
  const send = async () =>
    Schema.decodeUnknownSync(CommandResult)(
      await abortable(
        getRunner().then(tabId =>
          sendTabMessage(tabId, {
            type: 'RUN_EXPORT',
            sourceUrl: command._tag === 'Export' ? command.sourceUrl : '',
            originKind: command._tag === 'InstantsExport' ? 'instants' : 'source',
            ...(login ? { login } : {}),
            command,
            ...(preparedMedia ? { preparedMedia } : {}),
          })
        ),
        signal
      )
    );
  runnerProgress = emit;
  try {
    return await send().catch(() => {
      if (signal.aborted) throw cancellationError();
      discardRunner();
      return send();
    });
  } finally {
    runnerProgress = undefined;
  }
}

function protocolFailure(failure: OperationFailure): ProtocolOperationFailure {
  return ProtocolOperationFailure.make({ code: failure.code, scope: failure.scope });
}

/** Resolves an origin for the CLI, numbering its items from 1. */
async function inspectedMedia(
  origin: HistoryOrigin,
  login: InstagramLogin | undefined
): Promise<InspectedMedia[]> {
  const result = await mediaWithHistory(origin, login);
  if (result.failure) throw protocolFailure(result.failure);
  return result.media.map((item, index) =>
    InspectedMedia.make({
      itemNumber: HumanItemNumber.make(index + 1),
      mediaIdentity: MediaIdentity.make({
        itemIndex: InternalItemIndex.make(item.itemIndex),
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      }),
      mediaType: item.type,
      url: item.url,
      ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
      filenameHint: item.filenameHint,
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
      ...(item.creatorUsername ? { creatorUsername: item.creatorUsername } : {}),
      ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
      ...(item.history ? { history: ProtocolHistoryMarker.make(item.history) } : {}),
    })
  );
}

/** Resolves what a command addresses: the Source it names, or else the Instants feed. */
async function inspect(
  command: Inspect | InstantsInspect | ProtocolExportCommand,
  login: InstagramLogin | undefined
): Promise<InspectResult | InstantsInspectResult> {
  if (command._tag === 'InstantsInspect' || command._tag === 'InstantsExport')
    return InstantsInspectResult.make({ items: await inspectedMedia({ kind: 'instants' }, login) });
  const origin = sourceOrigin(command.sourceUrl);
  if (!origin) throw protocolFailure(invalidSourceUrl());
  return InspectResult.make({
    sourceUrl: origin.sourceUrl,
    items: await inspectedMedia(origin, login),
  });
}

async function runExport(
  command: ProtocolExportCommand,
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
  login: InstagramLogin | undefined
) {
  if (command.operations.every(deliversOriginal))
    return runDirectExport(command, emit, signal, login);
  return withRunner(signal, () => exportInRunner(command, emit, signal, login));
}

// fallow-ignore-next-line complexity
async function runDirectExport(
  command: ProtocolExportCommand,
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
  login: InstagramLogin | undefined
) {
  const inspected = await abortable(inspect(command, login), signal);
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
    operations.push(
      originalDownload(requested.operationId, {
        itemIndex: item.mediaIdentity.itemIndex,
        mediaId: item.mediaIdentity.mediaId,
        url: item.url,
        filenameHint: item.filenameHint,
        mediaType: item.mediaType,
      })
    );
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
          itemIndex: InternalItemIndex.make(requested.itemNumber - 1),
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

/** The export that reproduces a history entry's recorded mode, rotation and crop. */
function historyExport(entry: DownloadHistoryEntry, item: MediaItem): ProtocolExportCommand {
  const operations = [
    ProtocolExportOperation.make({
      operationId: ProtocolOperationId.make(crypto.randomUUID()),
      itemNumber: HumanItemNumber.make(item.itemIndex + 1),
      mediaIdentity: MediaIdentity.make({
        itemIndex: InternalItemIndex.make(item.itemIndex),
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      }),
      ...historySettings(entry),
    }),
  ];
  return entry.origin.kind === 'instants'
    ? ProtocolInstantsExport.make({ operations })
    : ProtocolExport.make({ sourceUrl: entry.origin.sourceUrl, operations });
}

/** Re-downloads one entry from a single resolve, answering the failure code if it did not start. */
async function redownloadEntry(
  entry: DownloadHistoryEntry,
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
  login: InstagramLogin | undefined
): Promise<ProtocolOperationFailure['code'] | undefined> {
  const resolved = await abortable(resolveHistoryItem(entry, login), signal);
  if (resolved.failure) return resolved.failure.code;
  const { item } = resolved;
  if (!needsRunner(entry)) {
    const response = await abortable(downloadHistoryOriginal(entry, item), signal);
    if (response.failure) return response.failure.code;
    return response.results.every(result => result.status === 'started')
      ? undefined
      : 'MEDIA_NOT_FOUND';
  }
  const result = await exportInRunner(historyExport(entry, item), emit, signal, login, [item]);
  return result._tag === 'ExportResult' &&
    result.outcomes.some(outcome => outcome._tag !== 'ItemSucceeded')
    ? 'DOWNLOAD_UNEXPECTED_FAILURE'
    : undefined;
}

/** Reads History for a CLI command, which cannot go on from a store a newer version wrote. */
async function readHistory(signal: AbortSignal) {
  const history = await abortable(getHistory(), signal);
  if (history.kind === 'unknown-version') throw new Error('Unsupported history version.');
  return history;
}

const diagnosticsReport = () =>
  buildDiagnostics({
    extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
    userAgent: globalThis.navigator?.userAgent ?? '',
  });

/** Re-downloads CLI history entries in turn, holding one runner across them when any needs it. */
async function redownloadHistory(
  command: HistoryRedownload,
  emit: (event: EventPayload) => void,
  signal: AbortSignal,
  login: InstagramLogin | undefined
): Promise<HistoryRedownloadResult> {
  const before = await readHistory(signal);
  const known = new Map(instagramEntries(before.entries).map(entry => [entry.id, entry]));
  const entries = command.entryIds.flatMap(id => known.get(id) ?? []);
  const redownloadAll = async () => {
    const outcomes = [];
    for (const entry of entries) {
      signal.throwIfAborted();
      const code = await redownloadEntry(entry, emit, signal, login);
      outcomes.push(
        code
          ? HistoryRedownloadFailed.make({
              entryId: entry.id,
              failure: ProtocolOperationFailure.make({ code, scope: 'item' }),
            })
          : HistoryRedownloadStarted.make({ entryId: entry.id })
      );
    }
    return HistoryRedownloadResult.make({
      outcomes,
      unknownEntryIds: command.entryIds.filter(id => !known.has(id)),
    });
  };
  return entries.some(needsRunner) ? withRunner(signal, redownloadAll) : redownloadAll();
}

// fallow-ignore-next-line complexity
async function executeCommand(
  request: Request,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
): Promise<void> {
  try {
    const { command, login } = request;
    let result: CommandResult;
    switch (command._tag) {
      case 'Inspect':
      case 'InstantsInspect':
        emit(Progress.make({ phase: 'resolving' }));
        result = await abortable(inspect(command, login), signal);
        break;
      case 'Export':
      case 'InstantsExport':
        emit(Progress.make({ phase: 'resolving' }));
        result = await runExport(command, emit, signal, login);
        break;
      case 'HistoryList': {
        emit(Progress.make({ phase: 'history' }));
        const history = await readHistory(signal);
        result = HistoryListResult.make({
          entries: instagramEntries(history.entries)
            .reverse()
            .flatMap(entry => Option.toArray(protocolHistoryEntry(entry))),
          repaired: history.repaired,
        });
        break;
      }
      case 'HistoryRemove': {
        const before = await readHistory(signal);
        const known = new Set(instagramEntries(before.entries).map(entry => entry.id));
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
        const before = await readHistory(signal);
        await abortable(clearHistory(), signal);
        result = HistoryClearResult.make({ clearedCount: before.entries.length });
        break;
      }
      case 'HistoryRedownload':
        result = await redownloadHistory(command, emit, signal, login);
        break;
      case 'DebugGet': {
        signal.throwIfAborted();
        emit(Progress.make({ phase: 'diagnostics' }));
        result = DebugGetResult.make({ diagnosticsVersion: 2, report: diagnosticsReport() });
        break;
      }
      case 'DebugExport': {
        signal.throwIfAborted();
        const filename = `gramgrab-debug-${Date.now()}.json`;
        await browser.downloads.download({
          url: jsonToDataUrl(JSON.parse(diagnosticsReport())),
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
      case 'WatchMove':
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
          runWatchCommand(
            command,
            runPreparedInDocument,
            watchCheck => emit(Progress.make({ phase: 'watch-check', watchCheck })),
            login
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
      case 'Echo':
      case 'Status':
      case 'WatchesExport':
      case 'WatchesImport':
        throw new Error('Unsupported command.');
      default:
        return command satisfies never;
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

void installInstagramOrigin();
startNativeBridge(executeCommand);
// The linked login's cookie rule lives in session rules, which a browser restart clears.
void restoreLinkedRule();
listenForLinkedCookies();
browser.runtime.onStartup.addListener(() => startNativeBridge(executeCommand));

// Watches: one periodic alarm wakes the worker to run due checks. Each wake, browser start, and
// installation recreates the alarm if the browser dropped it. An update re-checks kinds whose
// problem the older version recorded from an answer it could not read.
browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM_NAME) return;
  void ensureAlarm();
  void pump();
});
browser.runtime.onStartup.addListener(() => void holdForStartup().then(ensureAlarm));
browser.runtime.onInstalled.addListener(details => {
  void ensureAlarm();
  if (details.reason === 'update') void retryAfterUpdate();
});
// A Watch notification opens that Watch's Inbox tab on the Watches page.
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
  DELETE_HISTORY_ENTRY: message => historyAfter(() => removeHistoryEntries([message.entryId])),
  CLEAR_DOWNLOAD_HISTORY: async () => {
    try {
      await clearHistory();
      return { failure: undefined };
    } catch {
      return { failure: historyFailure('HISTORY_STORE_FAILED') };
    }
  },
  REDOWNLOAD_HISTORY_ENTRY: handleRedownloadHistoryEntry,
  DOWNLOAD_FRAME_EXPORT: handleDownloadFrameExport,
  RECORD_SILENT_EXPORT: message => recordDocumentExport(message, 'silent'),
  RECORD_DIRECT_EXPORT: message => recordDocumentExport(message, 'direct'),
  FETCH_VIDEO_BLOB: handleFetchVideoBlob,
  WATCH_COMMAND: message =>
    runWatchCommand(message.command, runPreparedInDocument, undefined, message.login),
  WATCH_READ: message => runWatchRead(message.command, message.viewer, message.login),
  WATCH_PREVIEW: message => previewWatchTarget(message.target, message.login),
  WATCH_AVATARS: message => watchAvatars(message.viewerId),
  WATCH_INBOX_PREVIEW: message => previewInboxEntry(message.entryId, message.login),
  WATCH_INBOX_RESTORE: message => restoreInboxEntries(message.entryIds, message.login),
  LINK_LOGIN: linkLogin,
  UNLINK_LOGIN: unlinkLinkedLogin,
  LOGIN_NAMES: loginNames,
};

/** Indexing the handler map with a type parameter keeps the request and its response correlated. */
function answer<T extends BackgroundMessageType>(
  type: T,
  message: MessageOf<T>
): Promise<MessageResponse<T>> {
  return messageHandlers[type](message);
}

const RUNNER_PHASES: Record<string, ProgressPhase> = {
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
