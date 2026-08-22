import { Either, Schema } from 'effect';
import {
  Export as ProtocolExport,
  InstantsExport as ProtocolInstantsExport,
  HumanItemNumber,
  OperationId as ProtocolOperationId,
  type ExportResult,
  type MediaItem,
} from '@gramgrab/protocol';
import { DownloadMediaRequest, type DownloadMediaResponse } from '../download/contracts.ts';
import type { OperationFailure, WarningCode } from '../errors/contracts.ts';
import type { HistoryEntry } from '../history/contracts.ts';

// ---------------------------------------------------------------------------
// Request schemas
//
// One schema per wire `type`. These are the only messages the extension speaks to itself, and the
// dispatcher decodes an incoming message against exactly one of them before any handler sees it.
// ---------------------------------------------------------------------------

const OriginKind = Schema.Literal('source', 'instants');

const HistoryItem = Schema.Struct({
  itemIndex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  mediaId: Schema.optional(Schema.String),
  url: Schema.String.pipe(Schema.nonEmptyString()),
  filename: Schema.String.pipe(Schema.nonEmptyString()),
  mediaType: Schema.Literal('image', 'video'),
});

const FrameHistoryItem = Schema.Struct({
  ...HistoryItem.fields,
  mediaType: Schema.Literal('video'),
  frameTimestampSeconds: Schema.Number.pipe(Schema.nonNegative()),
});

const RecordExportFields = {
  sourceUrl: Schema.String,
  originKind: Schema.optional(OriginKind),
} as const;

const FetchMedia = Schema.Struct({
  type: Schema.Literal('FETCH_MEDIA'),
  url: Schema.String,
});

const FetchInstants = Schema.Struct({ type: Schema.Literal('FETCH_INSTANTS') });

const GetPreviewUrl = Schema.Struct({
  type: Schema.Literal('GET_PREVIEW_URL'),
  url: Schema.String.pipe(Schema.nonEmptyString()),
});

const FetchVideoBlob = Schema.Struct({
  type: Schema.Literal('FETCH_VIDEO_BLOB'),
  url: Schema.String.pipe(Schema.nonEmptyString()),
});

const DownloadMedia = Schema.Struct({
  type: Schema.Literal('DOWNLOAD_MEDIA'),
  ...DownloadMediaRequest.fields,
});

const GetDownloadHistory = Schema.Struct({ type: Schema.Literal('GET_DOWNLOAD_HISTORY') });

const ClearDownloadHistory = Schema.Struct({ type: Schema.Literal('CLEAR_DOWNLOAD_HISTORY') });

const DeleteHistoryEntry = Schema.Struct({
  type: Schema.Literal('DELETE_HISTORY_ENTRY'),
  entryId: Schema.String.pipe(Schema.nonEmptyString()),
});

const RedownloadHistoryEntry = Schema.Struct({
  type: Schema.Literal('REDOWNLOAD_HISTORY_ENTRY'),
  entryId: Schema.String.pipe(Schema.nonEmptyString()),
});

// The receipt stays `Unknown` here on purpose: its privacy contract is an exact shape with no
// excess properties, which `decodeWhatsAppHistoryReceipt` enforces on its own. Applying that
// strictness at the message level would also reject additive fields from a newer sender.
const RecordWhatsAppHistory = Schema.Struct({
  type: Schema.Literal('RECORD_WHATSAPP_HISTORY'),
  receipt: Schema.Unknown,
});

const DeleteWhatsAppHistoryReceipt = Schema.Struct({
  type: Schema.Literal('DELETE_WHATSAPP_HISTORY_RECEIPT'),
  receipt: Schema.Unknown,
});

const RecordFrameExport = Schema.Struct({
  type: Schema.Literal('RECORD_FRAME_EXPORT'),
  ...RecordExportFields,
  item: FrameHistoryItem,
});

const DownloadFrameExport = Schema.Struct({
  type: Schema.Literal('DOWNLOAD_FRAME_EXPORT'),
  ...RecordExportFields,
  dataUrl: Schema.String.pipe(Schema.nonEmptyString()),
  item: FrameHistoryItem,
});

const RecordSilentExport = Schema.Struct({
  type: Schema.Literal('RECORD_SILENT_EXPORT'),
  ...RecordExportFields,
  item: HistoryItem,
});

const DebugShape = Schema.Struct({
  type: Schema.Literal('DEBUG_SHAPE'),
  url: Schema.optional(Schema.String),
});

const DownloadDebugJson = Schema.Struct({
  type: Schema.Literal('DOWNLOAD_DEBUG_JSON'),
  json: Schema.optional(Schema.Unknown),
});

const RunExport = Schema.Struct({
  type: Schema.Literal('RUN_EXPORT'),
  sourceUrl: Schema.String,
  originKind: OriginKind,
  command: Schema.Union(ProtocolExport, ProtocolInstantsExport),
});

const RunnerReady = Schema.Struct({ type: Schema.Literal('RUNNER_READY') });

const RunnerProgress = Schema.Struct({
  type: Schema.Literal('RUNNER_PROGRESS'),
  operationId: Schema.optional(ProtocolOperationId),
  itemNumber: Schema.optional(HumanItemNumber),
  // Progress phases are advisory and mapped through a table with a fallback, so an unrecognized
  // phase from a newer runner degrades instead of dropping the whole event.
  phase: Schema.String,
  progress: Schema.optional(Schema.Number),
});

/** Every message the extension sends itself, discriminated by the wire `type`. */
const MessageSchema = Schema.Union(
  FetchMedia,
  FetchInstants,
  GetPreviewUrl,
  FetchVideoBlob,
  DownloadMedia,
  GetDownloadHistory,
  ClearDownloadHistory,
  DeleteHistoryEntry,
  RedownloadHistoryEntry,
  RecordWhatsAppHistory,
  DeleteWhatsAppHistoryReceipt,
  RecordFrameExport,
  DownloadFrameExport,
  RecordSilentExport,
  DebugShape,
  DownloadDebugJson,
  RunExport,
  RunnerReady,
  RunnerProgress
);

export type Message = Schema.Schema.Type<typeof MessageSchema>;
export type MessageType = Message['type'];
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;

/** Messages that travel one way and are never answered. */
export type NotificationType = 'RUNNER_READY' | 'RUNNER_PROGRESS';

/** Messages the background worker answers. `RUN_EXPORT` is answered by the runner document. */
export type BackgroundMessageType = Exclude<MessageType, NotificationType | 'RUN_EXPORT'>;

// ---------------------------------------------------------------------------
// Response types
//
// Responses are correlated with their request at compile time and are not decoded at runtime, so
// a background worker that adds a response field never breaks a popup that predates it.
// ---------------------------------------------------------------------------

interface SourceMediaResponse {
  sourceUrl?: string;
  media?: readonly MediaItem[];
  failure?: OperationFailure;
}

interface InstantsMediaResponse {
  acquisition?: 'instants';
  media?: readonly MediaItem[];
  failure?: OperationFailure;
}

interface HistoryEntriesResponse {
  entries: readonly HistoryEntry[];
  failure: OperationFailure | undefined;
}

interface FailureOnlyResponse {
  failure: OperationFailure | undefined;
}

/**
 * An export that writes a history entry after the file is on its way. A failed export is a
 * failure; a saved file whose history entry could not be written is only a warning.
 */
interface ExportRecordResponse {
  failure?: OperationFailure;
  warning?: WarningCode;
}

interface RedownloadFrame {
  itemIndex: number;
  mediaId?: string;
  url: string;
  filenameHint: string;
  timestampSeconds: number;
  sourceUrl: string;
  originKind: 'source' | 'instants';
}

type RedownloadSilent = Omit<RedownloadFrame, 'timestampSeconds'>;

type RedownloadHistoryEntryResponse =
  | { failure: OperationFailure }
  | { frame: RedownloadFrame; failure: undefined }
  | { silent: RedownloadSilent; failure: undefined }
  | DownloadMediaResponse;

interface MessageResponses extends Record<MessageType, unknown> {
  FETCH_MEDIA: SourceMediaResponse;
  FETCH_INSTANTS: InstantsMediaResponse;
  GET_PREVIEW_URL: { previewUrl: string | undefined; failure: OperationFailure | undefined };
  FETCH_VIDEO_BLOB: { dataUrl: string | undefined; failure: OperationFailure | undefined };
  DOWNLOAD_MEDIA: DownloadMediaResponse;
  GET_DOWNLOAD_HISTORY: HistoryEntriesResponse;
  CLEAR_DOWNLOAD_HISTORY: FailureOnlyResponse;
  DELETE_HISTORY_ENTRY: HistoryEntriesResponse;
  REDOWNLOAD_HISTORY_ENTRY: RedownloadHistoryEntryResponse;
  RECORD_WHATSAPP_HISTORY: { saved?: true; warning?: 'HISTORY_SAVE_FAILED' };
  DELETE_WHATSAPP_HISTORY_RECEIPT: HistoryEntriesResponse;
  RECORD_FRAME_EXPORT: ExportRecordResponse;
  DOWNLOAD_FRAME_EXPORT: ExportRecordResponse;
  RECORD_SILENT_EXPORT: ExportRecordResponse;
  // A debug inspection surface, not an operation: `raw` is the unmodified upstream response and
  // `error` is its free-form counterpart. Neither is rendered as UI copy or offered for copying,
  // so neither belongs in the failure registry.
  DEBUG_SHAPE: { raw?: unknown; error?: string };
  DOWNLOAD_DEBUG_JSON: FailureOnlyResponse;
  RUN_EXPORT: ExportResult;
  RUNNER_READY: void;
  RUNNER_PROGRESS: void;
}

export type MessageResponse<T extends MessageType> = MessageResponses[T];

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const MESSAGE_TYPES: ReadonlySet<string> = new Set(
  MessageSchema.members.map(member => member.fields.type.literals[0])
);

function isMessageType(value: string): value is MessageType {
  return MESSAGE_TYPES.has(value);
}

/**
 * What a receiver should do with an incoming message.
 *
 * `foreign` covers both another document's message and a type this build does not know, so a
 * newer sender never forces an older receiver to answer something it cannot model. `unsupported`
 * is a message this build recognizes but cannot read; the receiver answers with that type's
 * refusal rather than guessing at the payload.
 */
export type MessageDecode =
  | { readonly kind: 'message'; readonly message: Message }
  | { readonly kind: 'unsupported'; readonly type: MessageType }
  | { readonly kind: 'foreign' };

function readMessageType(value: unknown): MessageType | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined;
  const type = value.type;
  return typeof type === 'string' && isMessageType(type) ? type : undefined;
}

export function decodeMessage(value: unknown): MessageDecode {
  const type = readMessageType(value);
  if (!type) return { kind: 'foreign' };
  const decoded = Schema.decodeUnknownEither(MessageSchema)(value);
  return Either.isRight(decoded)
    ? { kind: 'message', message: decoded.right }
    : { kind: 'unsupported', type };
}
