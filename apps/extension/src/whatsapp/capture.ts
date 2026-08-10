import { Either } from 'effect';
import { browser, type BrowserShim, type NativePort } from '../lib/browser.ts';
import { createOperationId, createRequestId, type OperationId } from '../download/contracts.ts';
import {
  CaptureAccept,
  CaptureCancel,
  CaptureFailure,
  CaptureStart,
  ChunkAck,
  decodeWhatsAppInbound,
  decodeWhatsAppOutbound,
  encodeWhatsAppInbound,
  decodeWhatsAppDescriptor,
  type CaptureMetadata as CaptureMetadataValue,
  type WhatsAppCaptureDescriptor,
  type WhatsAppOutboundEnvelope,
  type WhatsAppShapeEvidence,
} from './contracts.ts';
import {
  WHATSAPP_CONTROLLER_FILE,
  WHATSAPP_IDLE_TIMEOUT_MS,
  WHATSAPP_MAX_CHUNK_BYTES,
  WHATSAPP_MAX_CHUNKS,
  WHATSAPP_MAX_MEDIA_BYTES,
  WHATSAPP_MAX_UNACKNOWLEDGED_CHUNKS,
  WHATSAPP_PORT_NAME,
  WHATSAPP_PROTOCOL_VERSION,
  WHATSAPP_RETENTION_MS,
  WHATSAPP_TRANSFER_TIMEOUT_MS,
  extensionForWhatsAppMime,
  isWhatsAppWebUrl,
} from './limits.ts';
import { decodeCanonicalBase64 } from './base64.ts';
import { makeWhatsAppCaptureSnapshot, WhatsAppCaptureSnapshot } from './snapshot.ts';

export type WhatsAppCaptureFailureReason =
  | 'page-access-failed'
  | 'not-visible'
  | 'unsupported'
  | 'not-ready'
  | 'format-changed'
  | 'status-changed'
  | 'transfer-failed'
  | 'cancelled'
  | 'download-failed'
  | 'retention-expired';

export class WhatsAppCaptureError extends Error {
  readonly reason: WhatsAppCaptureFailureReason;
  readonly shape: WhatsAppShapeEvidence | undefined;
  readonly browserCause: unknown;

  constructor(
    reason: WhatsAppCaptureFailureReason,
    options: { readonly shape?: WhatsAppShapeEvidence; readonly browserCause?: unknown } = {}
  ) {
    super(reason);
    this.name = 'WhatsAppCaptureError';
    this.reason = reason;
    this.shape = options.shape;
    this.browserCause = options.browserCause;
  }
}

export interface WhatsAppDownloadResult {
  readonly downloadId: number;
  readonly filename: string;
}

export interface WhatsAppCaptureHandle {
  readonly descriptor: WhatsAppCaptureDescriptor;
  readonly snapshot: WhatsAppCaptureSnapshot;
  readonly filename: string;
  readonly download: () => Promise<WhatsAppDownloadResult>;
  readonly release: () => void;
}

export interface WhatsAppCaptureOptions {
  readonly browser?: BrowserShim;
  readonly now?: () => number;
  readonly operationId?: OperationId;
  readonly requestId?: ReturnType<typeof createRequestId>;
}

interface ActiveTab {
  readonly id: number;
  readonly url: string;
}

interface CapturePort extends NativePort {
  readonly name?: string;
}

function isCapturePort(port: NativePort): port is CapturePort {
  return port.name === WHATSAPP_PORT_NAME;
}

function removePortListener<T>(
  event: { removeListener?: (callback: T) => void },
  callback: T
): void {
  event.removeListener?.(callback);
}

function captureId(): string {
  return crypto.randomUUID();
}

function nameFreeFilename(descriptor: WhatsAppCaptureDescriptor): string {
  const stamp = new Date(descriptor.capturedAt)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return `whatsapp-visible-status-${stamp}.${extensionForWhatsAppMime(descriptor.mimeType)}`;
}

function activeTabFrom(tabs: readonly { id?: number; url?: string }[]): ActiveTab | undefined {
  if (tabs.length !== 1) return undefined;
  const tab = tabs[0];
  const url = tab?.url;
  if (tab?.id === undefined || !url || !isWhatsAppWebUrl(url)) return undefined;
  return { id: tab.id, url };
}

function responseFailureReason(value: CaptureFailure['reason']): WhatsAppCaptureFailureReason {
  switch (value) {
    case 'not-visible':
      return 'not-visible';
    case 'unsupported':
      return 'unsupported';
    case 'not-ready':
      return 'not-ready';
    case 'format-changed':
      return 'format-changed';
    case 'status-changed':
      return 'status-changed';
    case 'cancelled':
      return 'cancelled';
    case 'transfer-failed':
      return 'transfer-failed';
  }
}

function metadataDescriptor(
  metadata: CaptureMetadataValue,
  firstAcceptedByteAt: number,
  now: () => number
): WhatsAppCaptureDescriptor | undefined {
  const captureTime = now();
  const result = decodeWhatsAppDescriptor({
    captureId: captureId(),
    kind: metadata.kind,
    mimeType: metadata.mimeType,
    byteLength: metadata.byteLength,
    width: metadata.width,
    height: metadata.height,
    ...(metadata.kind === 'video' ? { durationMs: metadata.durationMs } : {}),
    capturedAt: captureTime,
    retentionDeadline: firstAcceptedByteAt + WHATSAPP_RETENTION_MS,
  });
  return Either.isRight(result) ? result.right : undefined;
}

let activeSession: WhatsAppCaptureSession | undefined;

export class WhatsAppCaptureSession {
  readonly operationId: OperationId;
  #requestId: ReturnType<typeof createRequestId>;
  #browser: BrowserShim;
  #now: () => number;
  #tabId: number | undefined;
  #port: CapturePort | undefined;
  #removePortListeners: (() => void) | undefined;
  #removeTabListeners: (() => void) | undefined;
  #removeWindowListeners: (() => void) | undefined;
  #removeDownloadListener: (() => void) | undefined;
  #absoluteTimer: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #retentionTimer: ReturnType<typeof setTimeout> | undefined;
  #firstAcceptedByteAt: number | undefined;
  #metadata: CaptureMetadataValue | undefined;
  #chunks: Uint8Array[] = [];
  #aggregateLength = 0;
  #expectedSequence = 0;
  #seenRequestIds = new Set<string>();
  #snapshot: WhatsAppCaptureSnapshot | undefined;
  #downloadId: number | undefined;
  #downloadTerminal = false;
  #settled = false;
  #accepted = false;
  #released = false;
  #resolveCapture: ((handle: WhatsAppCaptureHandle) => void) | undefined;
  #rejectCapture: ((error: WhatsAppCaptureError) => void) | undefined;
  #capturePromise: Promise<WhatsAppCaptureHandle> | undefined;

  constructor(options: WhatsAppCaptureOptions = {}) {
    this.#browser = options.browser ?? browser;
    this.#now = options.now ?? Date.now;
    this.operationId = options.operationId ?? createOperationId();
    this.#requestId = options.requestId ?? createRequestId();
  }

  async start(): Promise<WhatsAppCaptureHandle> {
    if (this.#capturePromise) return this.#capturePromise;
    this.#capturePromise = new Promise<WhatsAppCaptureHandle>((resolve, reject) => {
      this.#resolveCapture = resolve;
      this.#rejectCapture = reject;
    });
    try {
      this.#armAbsoluteTimer();
      const firstTab = await this.#findActiveWhatsAppTab();
      if (this.#released) throw new WhatsAppCaptureError('cancelled');
      if (!firstTab) throw new WhatsAppCaptureError('page-access-failed');
      this.#tabId = firstTab.id;
      await this.#browser.scripting.executeScript({
        target: { tabId: firstTab.id, frameIds: [0] },
        files: [WHATSAPP_CONTROLLER_FILE],
        world: 'ISOLATED',
      });
      if (this.#released) throw new WhatsAppCaptureError('cancelled');
      const secondTab = await this.#findActiveWhatsAppTab();
      if (this.#released) throw new WhatsAppCaptureError('cancelled');
      if (!secondTab || secondTab.id !== firstTab.id) {
        throw new WhatsAppCaptureError('page-access-failed');
      }
      const connected = this.#browser.tabs.connect(firstTab.id, {
        frameId: 0,
        name: WHATSAPP_PORT_NAME,
      });
      if (!isCapturePort(connected)) throw new WhatsAppCaptureError('page-access-failed');
      this.#port = connected;
      this.#installListeners();
      const finalTab = await this.#findActiveWhatsAppTab();
      if (this.#released) throw new WhatsAppCaptureError('cancelled');
      if (!finalTab || finalTab.id !== firstTab.id) {
        throw new WhatsAppCaptureError('page-access-failed');
      }
      this.#postStart();
    } catch (error) {
      const failure =
        error instanceof WhatsAppCaptureError
          ? error
          : new WhatsAppCaptureError('page-access-failed');
      this.#fail(failure);
    }
    return this.#capturePromise;
  }

  #findActiveWhatsAppTab(): Promise<ActiveTab | undefined> {
    return this.#browser.tabs
      .query({ active: true, currentWindow: true })
      .then(activeTabFrom)
      .catch(() => undefined);
  }

  #postStart(): void {
    const start = CaptureStart.make({
      protocolVersion: WHATSAPP_PROTOCOL_VERSION,
      requestId: this.#requestId,
      operationId: this.operationId,
      tag: 'CaptureStart',
      maxMediaBytes: WHATSAPP_MAX_MEDIA_BYTES,
      maxChunkBytes: WHATSAPP_MAX_CHUNK_BYTES,
      maxChunks: WHATSAPP_MAX_CHUNKS,
      maxUnacknowledgedChunks: WHATSAPP_MAX_UNACKNOWLEDGED_CHUNKS,
      idleTimeoutMs: WHATSAPP_IDLE_TIMEOUT_MS,
      transferTimeoutMs: WHATSAPP_TRANSFER_TIMEOUT_MS,
      retentionMs: WHATSAPP_RETENTION_MS,
    });
    this.#post(encodeWhatsAppInbound(start));
    this.#resetIdleTimer();
  }

  #installListeners(): void {
    const port = this.#port;
    const tabId = this.#tabId;
    if (!port || tabId === undefined) throw new WhatsAppCaptureError('page-access-failed');
    const onMessage = (value: unknown) => this.#handleMessage(value);
    const onDisconnect = () => {
      if (this.#accepted || this.#released) return;
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    this.#removePortListeners = () => {
      removePortListener(port.onMessage, onMessage);
      removePortListener(port.onDisconnect, onDisconnect);
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) this.#fail(new WhatsAppCaptureError('page-access-failed'));
    };
    const onUpdated = (updatedTabId: number, changeInfo: { url?: string; status?: string }) => {
      if (
        updatedTabId === tabId &&
        (changeInfo.url !== undefined || changeInfo.status === 'loading')
      )
        this.#fail(new WhatsAppCaptureError('page-access-failed'));
    };
    this.#browser.tabs.onRemoved.addListener(onRemoved);
    this.#browser.tabs.onUpdated.addListener(onUpdated);
    this.#removeTabListeners = () => {
      removePortListener(this.#browser.tabs.onRemoved, onRemoved);
      removePortListener(this.#browser.tabs.onUpdated, onUpdated);
    };

    if (typeof window !== 'undefined') {
      const onClose = () => this.release();
      window.addEventListener('pagehide', onClose);
      window.addEventListener('beforeunload', onClose);
      this.#removeWindowListeners = () => {
        window.removeEventListener('pagehide', onClose);
        window.removeEventListener('beforeunload', onClose);
      };
    }
  }

  #post(value: unknown): void {
    if (!this.#port || this.#released) throw new WhatsAppCaptureError('transfer-failed');
    const decoded = decodeWhatsAppInbound(value);
    if (Either.isLeft(decoded) || this.#seenRequestIds.has(decoded.right.requestId))
      throw new WhatsAppCaptureError('transfer-failed');
    this.#seenRequestIds.add(decoded.right.requestId);
    try {
      this.#port.postMessage(value);
    } catch {
      throw new WhatsAppCaptureError('transfer-failed');
    }
  }

  #armAbsoluteTimer(): void {
    this.#absoluteTimer = globalThis.setTimeout(
      () => this.#fail(new WhatsAppCaptureError('transfer-failed')),
      WHATSAPP_TRANSFER_TIMEOUT_MS
    );
  }

  #resetIdleTimer(): void {
    if (this.#idleTimer !== undefined) globalThis.clearTimeout(this.#idleTimer);
    this.#idleTimer = globalThis.setTimeout(
      () => this.#fail(new WhatsAppCaptureError('transfer-failed')),
      WHATSAPP_IDLE_TIMEOUT_MS
    );
  }

  #armRetentionTimer(): void {
    if (this.#firstAcceptedByteAt !== undefined) return;
    this.#firstAcceptedByteAt = this.#now();
    this.#retentionTimer = globalThis.setTimeout(
      () => this.#fail(new WhatsAppCaptureError('retention-expired')),
      WHATSAPP_RETENTION_MS
    );
  }

  #handleMessage(value: unknown): void {
    if (this.#settled || this.#released) return;
    const decoded = decodeWhatsAppOutbound(value);
    if (Either.isLeft(decoded)) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    const message = decoded.right;
    if (this.#seenRequestIds.has(message.requestId) || message.operationId !== this.operationId) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    this.#seenRequestIds.add(message.requestId);
    this.#resetIdleTimer();
    switch (message.tag) {
      case 'CaptureMetadata':
        this.#handleMetadata(message);
        return;
      case 'CaptureChunk':
        this.#handleChunk(message);
        return;
      case 'CaptureComplete':
        this.#handleComplete(message);
        return;
      case 'CaptureFailure':
        this.#fail(
          new WhatsAppCaptureError(
            responseFailureReason(message.reason),
            message.shape ? { shape: message.shape } : {}
          )
        );
        return;
    }
  }

  #handleMetadata(message: CaptureMetadataValue): void {
    if (this.#metadata || this.#chunks.length > 0 || this.#settled) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    this.#metadata = message;
  }

  #handleChunk(message: Extract<WhatsAppOutboundEnvelope, { tag: 'CaptureChunk' }>): void {
    if (!this.#metadata || this.#settled || message.sequence !== this.#expectedSequence) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    const decoded = decodeCanonicalBase64(message.payload);
    if (
      !decoded ||
      decoded.length !== message.decodedLength ||
      decoded.length > WHATSAPP_MAX_CHUNK_BYTES
    ) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    if (
      this.#chunks.length >= WHATSAPP_MAX_CHUNKS ||
      this.#aggregateLength + decoded.length > WHATSAPP_MAX_MEDIA_BYTES ||
      this.#aggregateLength + decoded.length > this.#metadata.byteLength
    ) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    this.#armRetentionTimer();
    this.#chunks.push(decoded);
    this.#aggregateLength += decoded.length;
    this.#expectedSequence++;
    try {
      this.#post(
        encodeWhatsAppInbound(
          ChunkAck.make({
            protocolVersion: WHATSAPP_PROTOCOL_VERSION,
            requestId: createRequestId(),
            operationId: this.operationId,
            tag: 'ChunkAck',
            sequence: message.sequence,
          })
        )
      );
    } catch (error) {
      this.#fail(
        error instanceof WhatsAppCaptureError ? error : new WhatsAppCaptureError('transfer-failed')
      );
    }
  }

  #handleComplete(message: Extract<WhatsAppOutboundEnvelope, { tag: 'CaptureComplete' }>): void {
    if (
      !this.#metadata ||
      this.#settled ||
      message.chunkCount !== this.#chunks.length ||
      message.chunkCount !== this.#expectedSequence ||
      message.byteLength !== this.#aggregateLength ||
      message.byteLength !== this.#metadata.byteLength
    ) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    const firstAcceptedByteAt = this.#firstAcceptedByteAt;
    if (firstAcceptedByteAt === undefined) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    const descriptor = metadataDescriptor(this.#metadata, firstAcceptedByteAt, this.#now);
    if (!descriptor) {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    try {
      this.#snapshot = makeWhatsAppCaptureSnapshot(descriptor, this.#chunks);
    } catch {
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    this.#chunks = [];
    if (this.#absoluteTimer !== undefined) globalThis.clearTimeout(this.#absoluteTimer);
    this.#absoluteTimer = undefined;
    this.#settled = true;
    this.#accepted = true;
    try {
      this.#post(
        encodeWhatsAppInbound(
          CaptureAccept.make({
            protocolVersion: WHATSAPP_PROTOCOL_VERSION,
            requestId: createRequestId(),
            operationId: this.operationId,
            tag: 'CaptureAccept',
            captureId: descriptor.captureId,
          })
        )
      );
      if (this.#idleTimer !== undefined) globalThis.clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    } catch {
      this.#settled = false;
      this.#accepted = false;
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    const snapshot = this.#snapshot;
    if (!snapshot) {
      this.#settled = false;
      this.#accepted = false;
      this.#fail(new WhatsAppCaptureError('transfer-failed'));
      return;
    }
    const handle: WhatsAppCaptureHandle = {
      descriptor,
      snapshot,
      filename: nameFreeFilename(descriptor),
      download: () => this.#download(handle),
      release: () => this.release(),
    };
    this.#resolveCapture?.(handle);
    this.#resolveCapture = undefined;
    this.#rejectCapture = undefined;
  }

  async #download(handle: WhatsAppCaptureHandle): Promise<WhatsAppDownloadResult> {
    if (this.#downloadId !== undefined && !this.#downloadTerminal) {
      return { downloadId: this.#downloadId, filename: handle.filename };
    }
    const snapshot = this.#snapshot;
    if (this.#released || snapshot !== handle.snapshot) {
      throw new WhatsAppCaptureError('download-failed');
    }
    let downloadId: number;
    try {
      downloadId = await this.#browser.downloads.download({
        url: snapshot.objectUrl(),
        filename: handle.filename,
        saveAs: false,
      });
    } catch (browserCause) {
      this.release();
      throw new WhatsAppCaptureError('download-failed', { browserCause });
    }
    if (this.#released || this.#snapshot !== snapshot) {
      await this.#browser.downloads.cancel(downloadId).catch(() => undefined);
      throw new WhatsAppCaptureError('download-failed');
    }
    this.#downloadId = downloadId;
    this.#downloadTerminal = false;
    this.#releaseSnapshot();
    const onChanged = (delta: { id: number; state?: { current?: string } }) => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'complete' || state === 'interrupted') {
        this.#downloadTerminal = true;
        this.release();
      }
    };
    this.#removeDownloadListener = () =>
      removePortListener(this.#browser.downloads.onChanged, onChanged);
    try {
      this.#browser.downloads.onChanged.addListener(onChanged);
    } catch {
      this.release();
      throw new WhatsAppCaptureError('download-failed');
    }
    try {
      const current = await this.#browser.downloads.search({ id: downloadId });
      const state = current[0]?.state;
      if (state === 'complete' || state === 'interrupted') {
        this.#downloadTerminal = true;
        this.release();
      }
    } catch {
      // The retention ceiling remains the fallback when the browser cannot report state.
    }
    return { downloadId, filename: handle.filename };
  }

  #releaseSnapshot(): void {
    this.#snapshot?.release();
    this.#snapshot = undefined;
  }

  #fail(error: WhatsAppCaptureError): void {
    if (this.#released) return;
    const wasSettled = this.#settled;
    const rejectCapture = this.#rejectCapture;
    if (!wasSettled) {
      this.#resolveCapture = undefined;
      this.#rejectCapture = undefined;
      rejectCapture?.(error);
    }
    const cancelReason =
      error.reason === 'retention-expired'
        ? 'timeout'
        : error.reason === 'page-access-failed'
          ? 'tab-invalidated'
          : 'protocol-error';
    this.release(cancelReason);
  }

  #sendCancel(
    reason:
      | 'user-cancelled'
      | 'popup-closed'
      | 'timeout'
      | 'protocol-error'
      | 'tab-invalidated'
      | 'port-disconnected'
  ): void {
    if (!this.#port || this.#accepted || this.#settled) return;
    try {
      this.#post(
        encodeWhatsAppInbound(
          CaptureCancel.make({
            protocolVersion: WHATSAPP_PROTOCOL_VERSION,
            requestId: createRequestId(),
            operationId: this.operationId,
            tag: 'CaptureCancel',
            reason,
          })
        )
      );
    } catch {
      // The port is already gone or rejected the cancellation.
    }
  }

  release(
    reason:
      | 'user-cancelled'
      | 'popup-closed'
      | 'timeout'
      | 'protocol-error'
      | 'tab-invalidated'
      | 'port-disconnected' = 'popup-closed'
  ): void {
    if (this.#released) return;
    this.#sendCancel(reason);
    this.#released = true;
    if (this.#absoluteTimer !== undefined) globalThis.clearTimeout(this.#absoluteTimer);
    if (this.#idleTimer !== undefined) globalThis.clearTimeout(this.#idleTimer);
    if (this.#retentionTimer !== undefined) globalThis.clearTimeout(this.#retentionTimer);
    this.#absoluteTimer = undefined;
    this.#idleTimer = undefined;
    this.#retentionTimer = undefined;
    this.#chunks = [];
    this.#metadata = undefined;
    this.#removePortListeners?.();
    this.#removePortListeners = undefined;
    this.#removeTabListeners?.();
    this.#removeTabListeners = undefined;
    this.#removeWindowListeners?.();
    this.#removeWindowListeners = undefined;
    this.#removeDownloadListener?.();
    this.#removeDownloadListener = undefined;
    const port = this.#port;
    this.#port = undefined;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // The tab or popup already disconnected the port.
      }
    }
    if (this.#downloadId !== undefined && !this.#downloadTerminal) {
      try {
        void this.#browser.downloads.cancel(this.#downloadId).catch(() => undefined);
      } catch {
        this.#downloadTerminal = true;
      }
    }
    this.#releaseSnapshot();
    if (!this.#settled) {
      this.#rejectCapture?.(new WhatsAppCaptureError('cancelled'));
    }
    this.#resolveCapture = undefined;
    this.#rejectCapture = undefined;
    if (activeSession === this) activeSession = undefined;
  }
}

export async function captureWhatsAppVisibleStatus(
  options: WhatsAppCaptureOptions = {}
): Promise<WhatsAppCaptureHandle> {
  activeSession?.release();
  const session = new WhatsAppCaptureSession(options);
  activeSession = session;
  return session.start();
}

export function nameFreeWhatsAppFilename(descriptor: WhatsAppCaptureDescriptor): string {
  return nameFreeFilename(descriptor);
}
