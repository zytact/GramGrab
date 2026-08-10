const WHATSAPP_PROTOCOL_VERSION = 1 as const;
const WHATSAPP_PORT_NAME = 'gramgrab-whatsapp-capture-v1';
const WHATSAPP_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const WHATSAPP_MAX_CHUNK_BYTES = 256 * 1024;
const WHATSAPP_MAX_CHUNKS = 256;
const WHATSAPP_IDLE_TIMEOUT_MS = 5_000;
const WHATSAPP_TRANSFER_TIMEOUT_MS = 30_000;
const WHATSAPP_MIN_DIMENSION = 1;
const WHATSAPP_MAX_DIMENSION = 16_384;
const WHATSAPP_MIN_VIDEO_DURATION_MS = 1;
const WHATSAPP_MAX_VIDEO_DURATION_MS = 600_000;
const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_MIME_TYPES = ['video/mp4'];

type WhatsAppMediaKind = 'photo' | 'video';
type WhatsAppMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';

function isWhatsAppMimeType(value: string): value is WhatsAppMimeType {
  return PHOTO_MIME_TYPES.includes(value) || VIDEO_MIME_TYPES.includes(value);
}

function isWhatsAppMimeForKind(
  kind: WhatsAppMediaKind,
  mimeType: string
): mimeType is WhatsAppMimeType {
  return kind === 'video'
    ? VIDEO_MIME_TYPES.includes(mimeType)
    : PHOTO_MIME_TYPES.includes(mimeType);
}
export type VisibleStatusObservation =
  | { readonly tag: 'not-visible'; readonly reason: 'wrong-origin' | 'viewer-absent' }
  | { readonly tag: 'unsupported'; readonly reason: 'unsupported-media' }
  | {
      readonly tag: 'not-ready';
      readonly reason: 'media-loading';
      readonly candidate: ForegroundCandidate;
    }
  | {
      readonly tag: 'format-changed';
      readonly shape: WhatsAppShapeEvidence;
    }
  | {
      readonly tag: 'ready';
      readonly candidate: ForegroundCandidate;
    };

export interface WhatsAppShapeEvidence {
  readonly playerCount: number;
  readonly imageCount: number;
  readonly blobImageCount: number;
  readonly dataImageCount: number;
  readonly videoCount: number;
  readonly markedVideoCount: number;
}

export interface ForegroundCandidate {
  readonly kind: WhatsAppMediaKind;
  readonly player: Element;
  readonly media: HTMLImageElement | HTMLVideoElement;
  readonly source: string;
  readonly ready: boolean;
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
}

interface AcquiredBytes {
  readonly candidate: ForegroundCandidate;
  readonly mimeType: WhatsAppMimeType;
  readonly bytes: Uint8Array;
}

export class ControllerFailure extends Error {
  readonly reason:
    | 'not-visible'
    | 'unsupported'
    | 'not-ready'
    | 'format-changed'
    | 'status-changed'
    | 'transfer-failed'
    | 'cancelled';
  readonly shape?: WhatsAppShapeEvidence;

  constructor(reason: ControllerFailure['reason'], shape?: WhatsAppShapeEvidence) {
    super(reason);
    this.name = 'ControllerFailure';
    this.reason = reason;
    this.shape = shape;
  }
}

function hasMarker(element: Element, marker: string): boolean {
  return (
    element.getAttribute('data-testid') === marker ||
    element.classList.contains(marker) ||
    element.getAttribute('aria-label') === marker
  );
}

function sourceOf(media: HTMLImageElement | HTMLVideoElement): string {
  return media instanceof HTMLVideoElement
    ? media.currentSrc || media.src
    : media.currentSrc || media.src;
}

function emptyShape(): WhatsAppShapeEvidence {
  return {
    playerCount: 0,
    imageCount: 0,
    blobImageCount: 0,
    dataImageCount: 0,
    videoCount: 0,
    markedVideoCount: 0,
  };
}

function boundedCount(value: number, maximum: number): number {
  return Math.min(value, maximum);
}

function shapeFor(player: Element | undefined, playerCount: number): WhatsAppShapeEvidence {
  if (!player) return { ...emptyShape(), playerCount: boundedCount(playerCount, 2) };
  const images = Array.from(player.querySelectorAll('img'));
  const videos = Array.from(player.querySelectorAll('video'));
  const imageSources = images.map(image => sourceOf(image));
  return {
    playerCount: boundedCount(playerCount, 2),
    imageCount: boundedCount(images.length, 8),
    blobImageCount: boundedCount(
      imageSources.filter(source => source.startsWith('blob:')).length,
      4
    ),
    dataImageCount: boundedCount(
      imageSources.filter(source => source.startsWith('data:')).length,
      8
    ),
    videoCount: boundedCount(videos.length, 2),
    markedVideoCount: boundedCount(
      videos.filter(video => hasMarker(video, 'status-video')).length,
      2
    ),
  };
}

function playerCandidates(document: Document): Element[] {
  const marked = Array.from(document.querySelectorAll('[data-testid="status-player-uie"]'));
  if (marked.length > 0) return marked;
  return Array.from(
    document.querySelectorAll('[data-testid*="status-player"], [class*="status-player"]')
  );
}

export function inspectVisibleStatus(
  document: Document = globalThis.document
): VisibleStatusObservation {
  const players = playerCandidates(document);
  if (players.length === 0) return { tag: 'not-visible', reason: 'viewer-absent' };
  if (players.length !== 1) {
    return { tag: 'format-changed', shape: shapeFor(players[0], players.length) };
  }

  const player = players[0];
  if (!player) return { tag: 'format-changed', shape: shapeFor(undefined, players.length) };
  const images = Array.from(player.querySelectorAll('img'));
  const videos = Array.from(player.querySelectorAll('video'));
  const markedVideos = videos.filter(video => hasMarker(video, 'status-video'));
  const shape = shapeFor(player, players.length);

  if (videos.length > 0 || markedVideos.length > 0) {
    if (videos.length !== 1 || markedVideos.length !== 1) {
      return { tag: 'format-changed', shape };
    }
    const video = videos[0];
    if (!video) return { tag: 'format-changed', shape };
    const source = sourceOf(video);
    if (!source.startsWith('blob:')) return { tag: 'format-changed', shape };
    const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
    const ready =
      video.readyState >= 2 &&
      Number.isFinite(video.videoWidth) &&
      Number.isFinite(video.videoHeight) &&
      video.videoWidth >= WHATSAPP_MIN_DIMENSION &&
      video.videoWidth <= WHATSAPP_MAX_DIMENSION &&
      video.videoHeight >= WHATSAPP_MIN_DIMENSION &&
      video.videoHeight <= WHATSAPP_MAX_DIMENSION &&
      durationMs >= WHATSAPP_MIN_VIDEO_DURATION_MS &&
      durationMs <= WHATSAPP_MAX_VIDEO_DURATION_MS;
    const candidate: ForegroundCandidate = {
      kind: 'video',
      player,
      media: video,
      source,
      ready,
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs,
    };
    return ready
      ? { tag: 'ready', candidate }
      : { tag: 'not-ready', reason: 'media-loading', candidate };
  }

  const foreground = images.filter(image => sourceOf(image).startsWith('blob:'));
  const invalidImageSources = images.filter(image => {
    const source = sourceOf(image);
    return source.length > 0 && !source.startsWith('blob:') && !source.startsWith('data:');
  });
  if (foreground.length > 1 || invalidImageSources.length > 0) {
    return { tag: 'format-changed', shape };
  }
  if (foreground.length === 0) return { tag: 'unsupported', reason: 'unsupported-media' };

  const image = foreground[0];
  if (!image) return { tag: 'format-changed', shape };
  const source = sourceOf(image);
  const ready =
    image.complete &&
    Number.isFinite(image.naturalWidth) &&
    Number.isFinite(image.naturalHeight) &&
    image.naturalWidth >= WHATSAPP_MIN_DIMENSION &&
    image.naturalWidth <= WHATSAPP_MAX_DIMENSION &&
    image.naturalHeight >= WHATSAPP_MIN_DIMENSION &&
    image.naturalHeight <= WHATSAPP_MAX_DIMENSION;
  const candidate: ForegroundCandidate = {
    kind: 'photo',
    player,
    media: image,
    source,
    ready,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  return ready
    ? { tag: 'ready', candidate }
    : { tag: 'not-ready', reason: 'media-loading', candidate };
}

export function guardMatches(
  guard: ForegroundCandidate,
  document: Document = globalThis.document
): boolean {
  const current = inspectVisibleStatus(document);
  return (
    current.tag === 'ready' &&
    current.candidate.kind === guard.kind &&
    current.candidate.player === guard.player &&
    current.candidate.media === guard.media &&
    sourceOf(current.candidate.media) === guard.source
  );
}

function isWhatsAppDocument(): boolean {
  const location = globalThis.location;
  return (
    location?.protocol === 'https:' &&
    location.hostname === 'web.whatsapp.com' &&
    location.port === ''
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

export async function waitForReady(
  initial: ForegroundCandidate,
  document: Document = globalThis.document,
  timeoutMs = WHATSAPP_IDLE_TIMEOUT_MS
): Promise<ForegroundCandidate> {
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  while (!current.ready) {
    if (!guardMatches(initial, document)) throw new ControllerFailure('status-changed');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ControllerFailure('not-ready');
    await sleep(Math.min(50, remaining));
    const next = inspectVisibleStatus(document);
    if (next.tag === 'format-changed') throw new ControllerFailure('format-changed', next.shape);
    if (next.tag !== 'ready') {
      if (next.tag !== 'not-ready' || !guardMatches(initial, document))
        throw new ControllerFailure('status-changed');
      continue;
    }
    if (!guardMatches(initial, document)) throw new ControllerFailure('status-changed');
    current = next.candidate;
  }
  return current;
}

function responseMimeType(response: Response): string | undefined {
  const header = response.headers.get('content-type');
  if (!header) return undefined;
  return header.split(';', 1)[0]?.trim().toLowerCase();
}

async function readResponseBytes(
  response: Response,
  guard: ForegroundCandidate,
  document: Document,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (!response.body) throw new ControllerFailure('transfer-failed');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      if (!guardMatches(guard, document)) throw new ControllerFailure('status-changed');
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      if (!result.value || result.value.length === 0) continue;
      total += result.value.length;
      if (total > WHATSAPP_MAX_MEDIA_BYTES) throw new ControllerFailure('transfer-failed');
      parts.push(result.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) throw new ControllerFailure('cancelled');
  if (!guardMatches(guard, document) || total === 0) {
    if (!guardMatches(guard, document)) throw new ControllerFailure('status-changed');
    throw new ControllerFailure('transfer-failed');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

export async function acquireVisibleStatusBytes(
  initial: ForegroundCandidate,
  document: Document = globalThis.document,
  signal: AbortSignal = new AbortController().signal
): Promise<AcquiredBytes> {
  const candidate = await waitForReady(initial, document);
  if (!guardMatches(candidate, document)) throw new ControllerFailure('status-changed');
  let response: Response;
  try {
    response = await fetch(candidate.source, { credentials: 'same-origin', signal });
  } catch {
    if (signal.aborted) throw new ControllerFailure('cancelled');
    throw new ControllerFailure('transfer-failed');
  }
  if (!response.ok) throw new ControllerFailure('transfer-failed');
  const mimeType = responseMimeType(response);
  if (
    !mimeType ||
    !isWhatsAppMimeType(mimeType) ||
    !isWhatsAppMimeForKind(candidate.kind, mimeType)
  ) {
    throw new ControllerFailure('format-changed');
  }
  const bytes = await readResponseBytes(response, candidate, document, signal);
  if (bytes.length > WHATSAPP_MAX_MEDIA_BYTES) throw new ControllerFailure('transfer-failed');
  return { candidate, mimeType, bytes };
}

function randomUuid(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const values = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(values);
  values[6] = (values[6] ?? 0) & 0x0f;
  values[6] = (values[6] ?? 0) | 0x40;
  values[8] = (values[8] ?? 0) & 0x3f;
  values[8] = (values[8] ?? 0) | 0x80;
  const hex = [...values].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function isControllerFailureReason(value: unknown): value is ControllerFailure['reason'] {
  return (
    value === 'not-visible' ||
    value === 'unsupported' ||
    value === 'not-ready' ||
    value === 'format-changed' ||
    value === 'status-changed' ||
    value === 'transfer-failed' ||
    value === 'cancelled'
  );
}

function isCancelReason(
  value: unknown
): value is
  | 'user-cancelled'
  | 'popup-closed'
  | 'timeout'
  | 'protocol-error'
  | 'tab-invalidated'
  | 'port-disconnected' {
  return (
    value === 'user-cancelled' ||
    value === 'popup-closed' ||
    value === 'timeout' ||
    value === 'protocol-error' ||
    value === 'tab-invalidated' ||
    value === 'port-disconnected'
  );
}

function isCanonicalBase64Shape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  );
}

function isShapeEvidence(value: unknown): value is WhatsAppShapeEvidence {
  return (
    isRecord(value) &&
    exactKeys(value, [
      'playerCount',
      'imageCount',
      'blobImageCount',
      'dataImageCount',
      'videoCount',
      'markedVideoCount',
    ]) &&
    isIntegerBetween(value.playerCount, 0, 2) &&
    isIntegerBetween(value.imageCount, 0, 8) &&
    isIntegerBetween(value.blobImageCount, 0, 4) &&
    isIntegerBetween(value.dataImageCount, 0, 8) &&
    isIntegerBetween(value.videoCount, 0, 2) &&
    isIntegerBetween(value.markedVideoCount, 0, 2)
  );
}

interface InboundBase {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly operationId: string;
  readonly tag: string;
}
interface StartMessage extends InboundBase {
  readonly tag: 'CaptureStart';
}
interface AckMessage extends InboundBase {
  readonly tag: 'ChunkAck';
  readonly sequence: number;
}
interface AcceptMessage extends InboundBase {
  readonly tag: 'CaptureAccept';
  readonly captureId: string;
}
interface CancelMessage extends InboundBase {
  readonly tag: 'CaptureCancel';
  readonly reason:
    | 'user-cancelled'
    | 'popup-closed'
    | 'timeout'
    | 'protocol-error'
    | 'tab-invalidated'
    | 'port-disconnected';
}
type InboundMessage = StartMessage | AckMessage | AcceptMessage | CancelMessage;

interface OutboundMetadata extends InboundBase {
  readonly tag: 'CaptureMetadata';
  readonly kind: WhatsAppMediaKind;
  readonly mimeType: WhatsAppMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
}
interface OutboundChunk extends InboundBase {
  readonly tag: 'CaptureChunk';
  readonly sequence: number;
  readonly decodedLength: number;
  readonly payload: string;
}
interface OutboundComplete extends InboundBase {
  readonly tag: 'CaptureComplete';
  readonly chunkCount: number;
  readonly byteLength: number;
}
interface OutboundFailure extends InboundBase {
  readonly tag: 'CaptureFailure';
  readonly reason: ControllerFailure['reason'];
  readonly shape?: WhatsAppShapeEvidence;
}
type OutboundMessage = OutboundMetadata | OutboundChunk | OutboundComplete | OutboundFailure;

export function decodeControllerInbound(value: unknown): InboundMessage | undefined {
  if (!isRecord(value)) return undefined;
  const baseKeys = ['protocolVersion', 'requestId', 'operationId', 'tag'];
  if (
    value.protocolVersion !== WHATSAPP_PROTOCOL_VERSION ||
    !isUuid(value.requestId) ||
    !isUuid(value.operationId) ||
    typeof value.tag !== 'string'
  )
    return undefined;
  const base: InboundBase = {
    protocolVersion: WHATSAPP_PROTOCOL_VERSION,
    requestId: value.requestId,
    operationId: value.operationId,
    tag: value.tag,
  };
  switch (value.tag) {
    case 'CaptureStart':
      if (
        !exactKeys(value, [
          ...baseKeys,
          'maxMediaBytes',
          'maxChunkBytes',
          'maxChunks',
          'maxUnacknowledgedChunks',
          'idleTimeoutMs',
          'transferTimeoutMs',
          'retentionMs',
        ])
      )
        return undefined;
      if (
        value.maxMediaBytes !== WHATSAPP_MAX_MEDIA_BYTES ||
        value.maxChunkBytes !== WHATSAPP_MAX_CHUNK_BYTES ||
        value.maxChunks !== WHATSAPP_MAX_CHUNKS ||
        value.maxUnacknowledgedChunks !== 1 ||
        value.idleTimeoutMs !== WHATSAPP_IDLE_TIMEOUT_MS ||
        value.transferTimeoutMs !== WHATSAPP_TRANSFER_TIMEOUT_MS ||
        value.retentionMs !== 60_000
      )
        return undefined;
      return { ...base, tag: 'CaptureStart' };
    case 'ChunkAck':
      if (
        !exactKeys(value, [...baseKeys, 'sequence']) ||
        !isIntegerBetween(value.sequence, 0, WHATSAPP_MAX_CHUNKS - 1)
      )
        return undefined;
      return { ...base, tag: 'ChunkAck', sequence: value.sequence };
    case 'CaptureAccept':
      if (!exactKeys(value, [...baseKeys, 'captureId']) || !isUuid(value.captureId))
        return undefined;
      return { ...base, tag: 'CaptureAccept', captureId: value.captureId };
    case 'CaptureCancel':
      if (!exactKeys(value, [...baseKeys, 'reason']) || !isCancelReason(value.reason))
        return undefined;
      return { ...base, tag: 'CaptureCancel', reason: value.reason };
    default:
      return undefined;
  }
}

export function decodeControllerOutbound(value: unknown): OutboundMessage | undefined {
  if (!isRecord(value)) return undefined;
  const baseKeys = ['protocolVersion', 'requestId', 'operationId', 'tag'];
  if (
    value.protocolVersion !== WHATSAPP_PROTOCOL_VERSION ||
    !isUuid(value.requestId) ||
    !isUuid(value.operationId) ||
    typeof value.tag !== 'string'
  )
    return undefined;
  const base: InboundBase = {
    protocolVersion: WHATSAPP_PROTOCOL_VERSION,
    requestId: value.requestId,
    operationId: value.operationId,
    tag: value.tag,
  };
  switch (value.tag) {
    case 'CaptureMetadata': {
      const common = [...baseKeys, 'kind', 'mimeType', 'byteLength', 'width', 'height'];
      if (value.kind === 'photo') {
        if (
          !exactKeys(value, common) ||
          typeof value.mimeType !== 'string' ||
          !isWhatsAppMimeForKind('photo', value.mimeType) ||
          !isIntegerBetween(value.byteLength, 1, WHATSAPP_MAX_MEDIA_BYTES) ||
          !isIntegerBetween(value.width, WHATSAPP_MIN_DIMENSION, WHATSAPP_MAX_DIMENSION) ||
          !isIntegerBetween(value.height, WHATSAPP_MIN_DIMENSION, WHATSAPP_MAX_DIMENSION)
        )
          return undefined;
        return {
          ...base,
          tag: 'CaptureMetadata',
          kind: 'photo',
          mimeType: value.mimeType,
          byteLength: value.byteLength,
          width: value.width,
          height: value.height,
        };
      }
      if (value.kind === 'video') {
        if (
          !exactKeys(value, [...common, 'durationMs']) ||
          typeof value.mimeType !== 'string' ||
          !isWhatsAppMimeForKind('video', value.mimeType) ||
          !isIntegerBetween(value.byteLength, 1, WHATSAPP_MAX_MEDIA_BYTES) ||
          !isIntegerBetween(value.width, WHATSAPP_MIN_DIMENSION, WHATSAPP_MAX_DIMENSION) ||
          !isIntegerBetween(value.height, WHATSAPP_MIN_DIMENSION, WHATSAPP_MAX_DIMENSION) ||
          !isIntegerBetween(
            value.durationMs,
            WHATSAPP_MIN_VIDEO_DURATION_MS,
            WHATSAPP_MAX_VIDEO_DURATION_MS
          )
        )
          return undefined;
        return {
          ...base,
          tag: 'CaptureMetadata',
          kind: 'video',
          mimeType: 'video/mp4',
          byteLength: value.byteLength,
          width: value.width,
          height: value.height,
          durationMs: value.durationMs,
        };
      }
      return undefined;
    }
    case 'CaptureChunk': {
      if (
        !exactKeys(value, [...baseKeys, 'sequence', 'decodedLength', 'payload']) ||
        !isIntegerBetween(value.sequence, 0, WHATSAPP_MAX_CHUNKS - 1) ||
        !isIntegerBetween(value.decodedLength, 1, WHATSAPP_MAX_CHUNK_BYTES) ||
        !isCanonicalBase64Shape(value.payload) ||
        value.payload.length > Math.ceil(WHATSAPP_MAX_CHUNK_BYTES / 3) * 4
      )
        return undefined;
      let binary: string;
      try {
        binary = atob(value.payload);
      } catch {
        return undefined;
      }
      const decodedLength = binary.length;
      const bytes = new Uint8Array(decodedLength);
      for (let index = 0; index < decodedLength; index++) bytes[index] = binary.charCodeAt(index);
      if (encodeControllerBase64(bytes) !== value.payload || decodedLength !== value.decodedLength)
        return undefined;
      return {
        ...base,
        tag: 'CaptureChunk',
        sequence: value.sequence,
        decodedLength: value.decodedLength,
        payload: value.payload,
      };
    }
    case 'CaptureComplete':
      if (
        !exactKeys(value, [...baseKeys, 'chunkCount', 'byteLength']) ||
        !isIntegerBetween(value.chunkCount, 1, WHATSAPP_MAX_CHUNKS) ||
        !isIntegerBetween(value.byteLength, 1, WHATSAPP_MAX_MEDIA_BYTES)
      )
        return undefined;
      return {
        ...base,
        tag: 'CaptureComplete',
        chunkCount: value.chunkCount,
        byteLength: value.byteLength,
      };
    case 'CaptureFailure': {
      if (
        !exactKeys(value, [
          ...baseKeys,
          'reason',
          ...(Object.prototype.hasOwnProperty.call(value, 'shape') ? ['shape'] : []),
        ]) ||
        !isControllerFailureReason(value.reason)
      )
        return undefined;
      if (Object.prototype.hasOwnProperty.call(value, 'shape') && !isShapeEvidence(value.shape))
        return undefined;
      const shape = isShapeEvidence(value.shape) ? value.shape : undefined;
      return { ...base, tag: 'CaptureFailure', reason: value.reason, ...(shape ? { shape } : {}) };
    }
    default:
      return undefined;
  }
}

interface RuntimeEvent<T> {
  addListener(listener: T): void;
  removeListener?(listener: T): void;
}
interface RuntimePort {
  readonly name?: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: RuntimeEvent<(message: unknown) => void>;
  onDisconnect: RuntimeEvent<() => void>;
}
interface RuntimeApi {
  onConnect: RuntimeEvent<(port: unknown) => void>;
}
interface RuntimeContainer {
  runtime: RuntimeApi;
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent<(...args: never[]) => void> {
  if (!isRecord(value)) return false;
  return typeof value.addListener === 'function';
}

function isRuntimeContainer(value: unknown): value is RuntimeContainer {
  if (!isRecord(value) || !isRecord(value.runtime)) return false;
  return isRuntimeEvent(value.runtime.onConnect);
}

function isRuntimePort(value: unknown): value is RuntimePort {
  if (!isRecord(value)) return false;
  if (typeof value.postMessage !== 'function' || typeof value.disconnect !== 'function')
    return false;
  if (!isRuntimeEvent(value.onMessage) || !isRuntimeEvent(value.onDisconnect)) return false;
  return typeof value.name === 'string';
}

function runtimeContainer(): RuntimeContainer | undefined {
  if (isRuntimeContainer(globalThis.browser)) return globalThis.browser;
  if (isRuntimeContainer(globalThis.chrome)) return globalThis.chrome;
  return undefined;
}

function encodeControllerBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 8_192, bytes.length))
    );
  }
  return btoa(binary);
}

function splitBytes(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += WHATSAPP_MAX_CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, Math.min(offset + WHATSAPP_MAX_CHUNK_BYTES, bytes.length)));
  }
  return chunks;
}

interface InstalledController {
  dispose: () => void;
}

declare global {
  var __gramgrabWhatsAppCaptureControllerV1: InstalledController | undefined;
}

export function installWhatsAppController(): void {
  globalThis.__gramgrabWhatsAppCaptureControllerV1?.dispose();
  const runtime = runtimeContainer();
  if (!runtime) return;

  let disposed = false;
  let usedPort = false;
  let port: RuntimePort | undefined;
  let runStarted = false;
  let completeSent = false;
  let terminal = false;
  let abortController: AbortController | undefined;
  let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingAck:
    | {
        sequence: number;
        resolve: () => void;
        reject: (error: ControllerFailure) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let bytes: Uint8Array | undefined;
  const seenRequestIds = new Set<string>();
  let removePortListeners: (() => void) | undefined;

  const clearTimers = () => {
    if (absoluteTimer !== undefined) globalThis.clearTimeout(absoluteTimer);
    if (idleTimer !== undefined) globalThis.clearTimeout(idleTimer);
    absoluteTimer = undefined;
    idleTimer = undefined;
    const pending = pendingAck;
    pendingAck = undefined;
    if (pending) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(new ControllerFailure('cancelled'));
    }
  };

  const resetIdleTimer = () => {
    if (idleTimer !== undefined) globalThis.clearTimeout(idleTimer);
    idleTimer = globalThis.setTimeout(() => fail('transfer-failed'), WHATSAPP_IDLE_TIMEOUT_MS);
  };

  const cleanupPort = () => {
    clearTimers();
    abortController?.abort();
    abortController = undefined;
    bytes = undefined;
    removePortListeners?.();
    removePortListeners = undefined;
    const current = port;
    port = undefined;
    if (current) {
      try {
        current.disconnect();
      } catch {
        // The browser already disconnected the tab port.
      }
    }
    runtime.runtime.onConnect.removeListener?.(onConnect);
    if (globalThis.__gramgrabWhatsAppCaptureControllerV1 === installed)
      globalThis.__gramgrabWhatsAppCaptureControllerV1 = undefined;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    terminal = true;
    cleanupPort();
    runtime.runtime.onConnect.removeListener?.(onConnect);
  };

  const installed: InstalledController = { dispose };
  globalThis.__gramgrabWhatsAppCaptureControllerV1 = installed;

  const post = (message: unknown): boolean => {
    if (disposed || !port) return false;
    const decoded = decodeControllerOutbound(message);
    if (!decoded || seenRequestIds.has(decoded.requestId)) {
      fail('transfer-failed');
      return false;
    }
    seenRequestIds.add(decoded.requestId);
    try {
      port.postMessage(message);
      if (!disposed && !terminal && port) resetIdleTimer();
      return true;
    } catch {
      fail('transfer-failed');
      return false;
    }
  };

  const sendFailure = (reason: ControllerFailure['reason'], shape?: WhatsAppShapeEvidence) => {
    if (terminal || !port) return;
    terminal = true;
    post({
      protocolVersion: WHATSAPP_PROTOCOL_VERSION,
      requestId: randomUuid(),
      operationId: currentOperationId,
      tag: 'CaptureFailure',
      reason,
      ...(shape ? { shape } : {}),
    });
    cleanupPort();
  };

  let currentOperationId = '';

  const fail = (reason: ControllerFailure['reason'], shape?: WhatsAppShapeEvidence) => {
    if (reason === 'cancelled' || disposed) {
      terminal = true;
      cleanupPort();
      return;
    }
    sendFailure(reason, shape);
  };

  const awaitAck = (sequence: number): Promise<void> => {
    if (pendingAck) return Promise.reject(new ControllerFailure('transfer-failed'));
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        pendingAck = undefined;
        reject(new ControllerFailure('transfer-failed'));
        fail('transfer-failed');
      }, WHATSAPP_IDLE_TIMEOUT_MS);
      pendingAck = { sequence, resolve, reject, timer };
    });
  };

  const run = async (start: StartMessage) => {
    currentOperationId = start.operationId;
    abortController = new AbortController();
    absoluteTimer = globalThis.setTimeout(
      () => fail('transfer-failed'),
      WHATSAPP_TRANSFER_TIMEOUT_MS
    );
    resetIdleTimer();
    try {
      if (!isWhatsAppDocument()) throw new ControllerFailure('transfer-failed');
      const initial = inspectVisibleStatus(globalThis.document);
      if (initial.tag === 'not-visible') throw new ControllerFailure('not-visible');
      if (initial.tag === 'unsupported') throw new ControllerFailure('unsupported');
      if (initial.tag === 'format-changed')
        throw new ControllerFailure('format-changed', initial.shape);
      const acquired = await acquireVisibleStatusBytes(
        initial.candidate,
        globalThis.document,
        abortController.signal
      );
      if (!isWhatsAppDocument()) throw new ControllerFailure('transfer-failed');
      if (!guardMatches(acquired.candidate, globalThis.document))
        throw new ControllerFailure('status-changed');
      const chunks = splitBytes(acquired.bytes);
      if (chunks.length === 0 || chunks.length > WHATSAPP_MAX_CHUNKS)
        throw new ControllerFailure('transfer-failed');
      const metadata = {
        protocolVersion: WHATSAPP_PROTOCOL_VERSION,
        requestId: randomUuid(),
        operationId: start.operationId,
        tag: 'CaptureMetadata' as const,
        kind: acquired.candidate.kind,
        mimeType: acquired.mimeType,
        byteLength: acquired.bytes.length,
        width: acquired.candidate.width,
        height: acquired.candidate.height,
        ...(acquired.candidate.kind === 'video'
          ? { durationMs: acquired.candidate.durationMs }
          : {}),
      };
      if (!post(metadata) || disposed || terminal) return;
      bytes = acquired.bytes;
      for (const [sequence, chunk] of chunks.entries()) {
        if (!guardMatches(acquired.candidate, globalThis.document))
          throw new ControllerFailure('status-changed');
        const payload = encodeControllerBase64(chunk);
        const acknowledged = awaitAck(sequence);
        const posted = post({
          protocolVersion: WHATSAPP_PROTOCOL_VERSION,
          requestId: randomUuid(),
          operationId: start.operationId,
          tag: 'CaptureChunk',
          sequence,
          decodedLength: chunk.length,
          payload,
        });
        if (!posted) {
          await acknowledged.catch(() => undefined);
          return;
        }
        await acknowledged;
        if (disposed || terminal) return;
      }
      if (!isWhatsAppDocument()) throw new ControllerFailure('transfer-failed');
      if (!guardMatches(acquired.candidate, globalThis.document))
        throw new ControllerFailure('status-changed');
      if (
        !post({
          protocolVersion: WHATSAPP_PROTOCOL_VERSION,
          requestId: randomUuid(),
          operationId: start.operationId,
          tag: 'CaptureComplete',
          chunkCount: chunks.length,
          byteLength: acquired.bytes.length,
        }) ||
        disposed ||
        terminal
      )
        return;
      completeSent = true;
      clearTimers();
      if (!disposed && !terminal) resetIdleTimer();
    } catch (error) {
      if (error instanceof ControllerFailure) fail(error.reason, error.shape);
      else fail('transfer-failed');
    }
  };

  const onMessage = (raw: unknown) => {
    const message = decodeControllerInbound(raw);
    if (
      !message ||
      (message.operationId !== currentOperationId && message.tag !== 'CaptureStart')
    ) {
      fail('transfer-failed');
      return;
    }
    if (seenRequestIds.has(message.requestId)) {
      fail('transfer-failed');
      return;
    }
    seenRequestIds.add(message.requestId);
    resetIdleTimer();
    switch (message.tag) {
      case 'CaptureStart':
        if (runStarted) {
          fail('transfer-failed');
          return;
        }
        runStarted = true;
        void run(message);
        return;
      case 'ChunkAck': {
        if (!pendingAck || pendingAck.sequence !== message.sequence) {
          fail('transfer-failed');
          return;
        }
        globalThis.clearTimeout(pendingAck.timer);
        const pending = pendingAck;
        pendingAck = undefined;
        pending.resolve();
        return;
      }
      case 'CaptureAccept':
        if (!runStarted || !completeSent || terminal || !bytes) {
          fail('transfer-failed');
          return;
        }
        terminal = true;
        cleanupPort();
        return;
      case 'CaptureCancel':
        fail('cancelled');
        return;
    }
  };

  const onDisconnect = () => {
    if (disposed || terminal) return;
    terminal = true;
    cleanupPort();
  };

  const onConnect = (rawPort: unknown) => {
    if (!isRuntimePort(rawPort) || rawPort.name !== WHATSAPP_PORT_NAME) return;
    if (usedPort || port || disposed) {
      rawPort.disconnect();
      return;
    }
    usedPort = true;
    port = rawPort;
    rawPort.onMessage.addListener(onMessage);
    rawPort.onDisconnect.addListener(onDisconnect);
    removePortListeners = () => {
      rawPort.onMessage.removeListener?.(onMessage);
      rawPort.onDisconnect.removeListener?.(onDisconnect);
    };
  };

  runtime.runtime.onConnect.addListener(onConnect);
}
