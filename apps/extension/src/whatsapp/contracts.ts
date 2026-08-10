import { Schema } from 'effect';
import { OperationIdSchema, RequestIdSchema } from '../download/contracts.ts';
import { decodeCanonicalBase64 } from './base64.ts';
import {
  WHATSAPP_MAX_CHUNK_BYTES,
  WHATSAPP_MAX_CHUNKS,
  WHATSAPP_MAX_DIMENSION,
  WHATSAPP_MAX_MEDIA_BYTES,
  WHATSAPP_MAX_VIDEO_DURATION_MS,
  WHATSAPP_MIN_DIMENSION,
  WHATSAPP_MIN_VIDEO_DURATION_MS,
  WHATSAPP_PROTOCOL_VERSION,
  WHATSAPP_RETENTION_MS,
  WHATSAPP_TRANSFER_TIMEOUT_MS,
  WHATSAPP_IDLE_TIMEOUT_MS,
  type WhatsAppMediaKind,
  type WhatsAppMimeType,
} from './limits.ts';

const ProtocolVersion = Schema.Literal(WHATSAPP_PROTOCOL_VERSION);
const CaptureIdSchema = Schema.UUID.pipe(Schema.brand('WhatsAppCaptureId'));
const ByteLength = Schema.Number.pipe(Schema.int(), Schema.between(1, WHATSAPP_MAX_MEDIA_BYTES));
const ChunkLength = Schema.Number.pipe(Schema.int(), Schema.between(1, WHATSAPP_MAX_CHUNK_BYTES));
const ChunkCount = Schema.Number.pipe(Schema.int(), Schema.between(1, WHATSAPP_MAX_CHUNKS));
const Dimension = Schema.Number.pipe(
  Schema.int(),
  Schema.between(WHATSAPP_MIN_DIMENSION, WHATSAPP_MAX_DIMENSION)
);
const DurationMs = Schema.Number.pipe(
  Schema.int(),
  Schema.between(WHATSAPP_MIN_VIDEO_DURATION_MS, WHATSAPP_MAX_VIDEO_DURATION_MS)
);
const CanonicalBase64Shape = Schema.String.pipe(
  Schema.pattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  Schema.filter(value => decodeCanonicalBase64(value) !== undefined, {
    message: () => 'must be canonical, non-empty base64 within the chunk limit',
  })
);
const PhotoMimeType = Schema.Literal('image/jpeg', 'image/png', 'image/webp');
const VideoMimeType = Schema.Literal('video/mp4');
const CaptureFailureReason = Schema.Literal(
  'not-visible',
  'unsupported',
  'not-ready',
  'format-changed',
  'status-changed',
  'transfer-failed',
  'cancelled'
);
const CancelReason = Schema.Literal(
  'user-cancelled',
  'popup-closed',
  'timeout',
  'protocol-error',
  'tab-invalidated',
  'port-disconnected'
);

export class WhatsAppShapeEvidence extends Schema.Class<WhatsAppShapeEvidence>(
  'WhatsAppShapeEvidence'
)({
  playerCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 2)),
  imageCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 8)),
  blobImageCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 4)),
  dataImageCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 8)),
  videoCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 2)),
  markedVideoCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 2)),
  overflow: Schema.Boolean,
}) {}

export class CaptureStart extends Schema.Class<CaptureStart>('CaptureStart')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureStart'),
  maxMediaBytes: Schema.Literal(WHATSAPP_MAX_MEDIA_BYTES),
  maxChunkBytes: Schema.Literal(WHATSAPP_MAX_CHUNK_BYTES),
  maxChunks: Schema.Literal(WHATSAPP_MAX_CHUNKS),
  maxUnacknowledgedChunks: Schema.Literal(1),
  idleTimeoutMs: Schema.Literal(WHATSAPP_IDLE_TIMEOUT_MS),
  transferTimeoutMs: Schema.Literal(WHATSAPP_TRANSFER_TIMEOUT_MS),
  retentionMs: Schema.Literal(WHATSAPP_RETENTION_MS),
}) {}

export class ChunkAck extends Schema.Class<ChunkAck>('ChunkAck')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('ChunkAck'),
  sequence: Schema.Number.pipe(Schema.int(), Schema.between(0, WHATSAPP_MAX_CHUNKS - 1)),
}) {}

export class CaptureAccept extends Schema.Class<CaptureAccept>('CaptureAccept')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureAccept'),
  captureId: CaptureIdSchema,
}) {}

export class CaptureCancel extends Schema.Class<CaptureCancel>('CaptureCancel')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureCancel'),
  reason: CancelReason,
}) {}

export const WhatsAppInboundEnvelope = Schema.Union(
  CaptureStart,
  ChunkAck,
  CaptureAccept,
  CaptureCancel
);
export type WhatsAppInboundEnvelope = Schema.Schema.Type<typeof WhatsAppInboundEnvelope>;

class PhotoCaptureMetadata extends Schema.Class<PhotoCaptureMetadata>('PhotoCaptureMetadata')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureMetadata'),
  kind: Schema.Literal('photo'),
  mimeType: PhotoMimeType,
  byteLength: ByteLength,
  width: Dimension,
  height: Dimension,
}) {}

class VideoCaptureMetadata extends Schema.Class<VideoCaptureMetadata>('VideoCaptureMetadata')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureMetadata'),
  kind: Schema.Literal('video'),
  mimeType: VideoMimeType,
  byteLength: ByteLength,
  width: Dimension,
  height: Dimension,
  durationMs: DurationMs,
}) {}

export const CaptureMetadata = Schema.Union(PhotoCaptureMetadata, VideoCaptureMetadata);
export type CaptureMetadata = Schema.Schema.Type<typeof CaptureMetadata>;

export class CaptureChunk extends Schema.Class<CaptureChunk>('CaptureChunk')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureChunk'),
  sequence: Schema.Number.pipe(Schema.int(), Schema.between(0, WHATSAPP_MAX_CHUNKS - 1)),
  decodedLength: ChunkLength,
  payload: CanonicalBase64Shape,
}) {}

export class CaptureComplete extends Schema.Class<CaptureComplete>('CaptureComplete')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureComplete'),
  chunkCount: ChunkCount,
  byteLength: ByteLength,
}) {}

export class CaptureFailure extends Schema.Class<CaptureFailure>('CaptureFailure')({
  protocolVersion: ProtocolVersion,
  requestId: RequestIdSchema,
  operationId: OperationIdSchema,
  tag: Schema.Literal('CaptureFailure'),
  reason: CaptureFailureReason,
  shape: Schema.optional(WhatsAppShapeEvidence),
}) {}

export const WhatsAppOutboundEnvelope = Schema.Union(
  CaptureMetadata,
  CaptureChunk,
  CaptureComplete,
  CaptureFailure
);
export type WhatsAppOutboundEnvelope = Schema.Schema.Type<typeof WhatsAppOutboundEnvelope>;

const CaptureTime = Schema.Number.pipe(Schema.int(), Schema.nonNegative());

class PhotoCaptureDescriptor extends Schema.Class<PhotoCaptureDescriptor>('PhotoCaptureDescriptor')(
  {
    captureId: CaptureIdSchema,
    kind: Schema.Literal('photo'),
    mimeType: PhotoMimeType,
    byteLength: ByteLength,
    width: Dimension,
    height: Dimension,
    capturedAt: CaptureTime,
    retentionDeadline: CaptureTime,
  }
) {}

class VideoCaptureDescriptor extends Schema.Class<VideoCaptureDescriptor>('VideoCaptureDescriptor')(
  {
    captureId: CaptureIdSchema,
    kind: Schema.Literal('video'),
    mimeType: VideoMimeType,
    byteLength: ByteLength,
    width: Dimension,
    height: Dimension,
    durationMs: DurationMs,
    capturedAt: CaptureTime,
    retentionDeadline: CaptureTime,
  }
) {}

export const WhatsAppCaptureDescriptor = Schema.Union(
  PhotoCaptureDescriptor,
  VideoCaptureDescriptor
);
export type WhatsAppCaptureDescriptor = Schema.Schema.Type<typeof WhatsAppCaptureDescriptor>;

export type WhatsAppCaptureKind = WhatsAppMediaKind;
export type WhatsAppCaptureMimeType = WhatsAppMimeType;
export type WhatsAppCaptureId = Schema.Schema.Type<typeof CaptureIdSchema>;

export function createWhatsAppCaptureId(): WhatsAppCaptureId {
  return Schema.decodeUnknownSync(CaptureIdSchema)(crypto.randomUUID());
}

const StrictParseOptions = { onExcessProperty: 'error' as const };

export function decodeWhatsAppInbound(value: unknown) {
  return Schema.decodeUnknownEither(WhatsAppInboundEnvelope, StrictParseOptions)(value);
}

export function decodeWhatsAppOutbound(value: unknown) {
  return Schema.decodeUnknownEither(WhatsAppOutboundEnvelope, StrictParseOptions)(value);
}

export function decodeWhatsAppDescriptor(value: unknown) {
  return Schema.decodeUnknownEither(WhatsAppCaptureDescriptor, StrictParseOptions)(value);
}

export function encodeWhatsAppInbound(value: WhatsAppInboundEnvelope): unknown {
  return Schema.encodeSync(WhatsAppInboundEnvelope, StrictParseOptions)(value);
}

export function encodeWhatsAppOutbound(value: WhatsAppOutboundEnvelope): unknown {
  return Schema.encodeSync(WhatsAppOutboundEnvelope, StrictParseOptions)(value);
}
