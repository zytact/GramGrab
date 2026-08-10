import { Schema } from 'effect';

export { decodeJsonFrame, encodeFrame, encodeJsonFrame, FrameDecoder } from './framing.ts';
export { localIpcEndpoint, type IpcEnvironment } from './ipc.ts';

export const PROTOCOL_VERSION = 1 as const;

export const RequestId = Schema.UUID.pipe(Schema.brand('RequestId'));
export type RequestId = Schema.Schema.Type<typeof RequestId>;

export const OperationId = Schema.UUID.pipe(Schema.brand('OperationId'));
export type OperationId = Schema.Schema.Type<typeof OperationId>;

export const HumanItemNumber = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.brand('HumanItemNumber')
);
export type HumanItemNumber = Schema.Schema.Type<typeof HumanItemNumber>;

export const InternalItemIndex = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand('InternalItemIndex')
);
export type InternalItemIndex = Schema.Schema.Type<typeof InternalItemIndex>;

export class MediaIdentity extends Schema.Class<MediaIdentity>('MediaIdentity')({
  itemIndex: InternalItemIndex,
  mediaId: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
}) {}

export class DirectExport extends Schema.TaggedClass<DirectExport>()('DirectExport', {}) {}

export class FrameExport extends Schema.TaggedClass<FrameExport>()('FrameExport', {
  timestampSeconds: Schema.Number.pipe(Schema.nonNegative()),
}) {}

export class SilentExport extends Schema.TaggedClass<SilentExport>()('SilentExport', {
  reencode: Schema.Literal('forbid', 'allow', 'require'),
}) {}

export const ExportMode = Schema.Union(DirectExport, FrameExport, SilentExport);
export type ExportMode = Schema.Schema.Type<typeof ExportMode>;

export class ExportOperation extends Schema.Class<ExportOperation>('ExportOperation')({
  operationId: OperationId,
  itemNumber: HumanItemNumber,
  mediaIdentity: Schema.optional(MediaIdentity),
  mode: ExportMode,
}) {}

export class Inspect extends Schema.TaggedClass<Inspect>()('Inspect', {
  sourceUrl: Schema.String.pipe(Schema.nonEmptyString()),
}) {}

export class InstantsInspect extends Schema.TaggedClass<InstantsInspect>()('InstantsInspect', {}) {}

export class Status extends Schema.TaggedClass<Status>()('Status', {}) {}

export class Echo extends Schema.TaggedClass<Echo>()('Echo', {
  value: Schema.Unknown,
}) {}

export class Export extends Schema.TaggedClass<Export>()('Export', {
  sourceUrl: Schema.String.pipe(Schema.nonEmptyString()),
  operations: Schema.Array(ExportOperation).pipe(Schema.minItems(1)),
}) {}

export class InstantsExport extends Schema.TaggedClass<InstantsExport>()('InstantsExport', {
  operations: Schema.Array(ExportOperation).pipe(Schema.minItems(1)),
}) {}

export class HistoryList extends Schema.TaggedClass<HistoryList>()('HistoryList', {}) {}

export class HistoryRemove extends Schema.TaggedClass<HistoryRemove>()('HistoryRemove', {
  entryIds: Schema.Array(Schema.String.pipe(Schema.nonEmptyString())).pipe(Schema.minItems(1)),
}) {}

export class HistoryClear extends Schema.TaggedClass<HistoryClear>()('HistoryClear', {}) {}

export class HistoryRedownload extends Schema.TaggedClass<HistoryRedownload>()(
  'HistoryRedownload',
  { entryIds: Schema.Array(Schema.String.pipe(Schema.nonEmptyString())).pipe(Schema.minItems(1)) }
) {}

export class DebugGet extends Schema.TaggedClass<DebugGet>()('DebugGet', {}) {}

export class DebugExport extends Schema.TaggedClass<DebugExport>()('DebugExport', {}) {}

export const Command = Schema.Union(
  Status,
  Echo,
  Inspect,
  InstantsInspect,
  Export,
  InstantsExport,
  HistoryList,
  HistoryRemove,
  HistoryClear,
  HistoryRedownload,
  DebugGet,
  DebugExport
);
export type Command = Schema.Schema.Type<typeof Command>;

export class Request extends Schema.Class<Request>('Request')({
  version: Schema.Literal(PROTOCOL_VERSION),
  requestId: RequestId,
  command: Command,
}) {}

export class CancelRequest extends Schema.TaggedClass<CancelRequest>()('CancelRequest', {
  version: Schema.Literal(PROTOCOL_VERSION),
  requestId: RequestId,
}) {}

export const ClientMessage = Schema.Union(Request, CancelRequest);
export type ClientMessage = Schema.Schema.Type<typeof ClientMessage>;

export const FAILURE_CODES = [
  'INPUT_INVALID_SOURCE_URL',
  'SOURCE_USERNAME_UNRESOLVED',
  'SOURCE_MEDIA_NOT_FOUND',
  'IG_NOT_AUTHENTICATED',
  'IG_ACCESS_FORBIDDEN',
  'IG_RATE_LIMITED',
  'IG_RESPONSE_SHAPE_UNKNOWN',
  'IG_REQUEST_REJECTED',
  'SOURCE_NETWORK_FAILED',
  'SOURCE_SERVER_FAILED',
  'SOURCE_UNEXPECTED_FAILURE',
  'MEDIA_URL_EXPIRED',
  'MEDIA_NOT_FOUND',
  'MEDIA_DASH_ONLY_UNSUPPORTED',
  'INSTANT_NOT_ACTIVE',
  'MEDIA_NETWORK_FAILED',
  'MEDIA_RESPONSE_EMPTY',
  'BROWSER_DOWNLOAD_BLOCKED',
  'BROWSER_DOWNLOAD_NETWORK_FAILED',
  'BROWSER_DOWNLOAD_FILE_FAILED',
  'DOWNLOAD_UNEXPECTED_FAILURE',
  'FRAME_METADATA_UNAVAILABLE',
  'FRAME_TIMEOUT',
  'FRAME_NO_DECODABLE_FRAME',
  'FRAME_CANVAS_UNAVAILABLE',
  'FRAME_IMAGE_ENCODING_FAILED',
  'FRAME_UNEXPECTED_FAILURE',
  'SILENT_STORAGE_UNAVAILABLE',
  'SILENT_STORAGE_CAPACITY_EXCEEDED',
  'SILENT_STORAGE_READ_FAILED',
  'SILENT_STORAGE_WRITE_FAILED',
  'SILENT_SOURCE_NO_VIDEO',
  'SILENT_INPUT_INSPECTION_FAILED',
  'SILENT_COPY_FAILED',
  'SILENT_H264_ENCODER_UNAVAILABLE',
  'SILENT_SOURCE_CONVERSION_UNSUPPORTED',
  'SILENT_REENCODE_FAILED',
  'SILENT_UNEXPECTED_FAILURE',
  'SILENT_OUTPUT_NO_VIDEO',
  'SILENT_OUTPUT_HAS_AUDIO',
  'SILENT_WORKER_UNAVAILABLE',
  'SILENT_WORKER_PROTOCOL_FAILURE',
] as const;

export const FailureCodeSchema = Schema.Literal(...FAILURE_CODES);
export type FailureCode = Schema.Schema.Type<typeof FailureCodeSchema>;

export class OperationFailure extends Schema.Class<OperationFailure>('ProtocolOperationFailure')({
  code: FailureCodeSchema,
  scope: Schema.Literal('batch', 'item'),
}) {}

export class TransportFailure extends Schema.TaggedClass<TransportFailure>()('TransportFailure', {
  code: Schema.Literal('IPC_UNAVAILABLE', 'IPC_DISCONNECTED', 'PROTOCOL_VERSION_UNSUPPORTED'),
}) {}

export class BrowserFailure extends Schema.TaggedClass<BrowserFailure>()('BrowserFailure', {
  code: Schema.Literal('BROWSER_UNAVAILABLE', 'EXTENSION_UNAVAILABLE'),
}) {}

export class ValidationFailure extends Schema.TaggedClass<ValidationFailure>()(
  'ValidationFailure',
  { message: Schema.String.pipe(Schema.nonEmptyString()) }
) {}

export class CommandFailure extends Schema.TaggedClass<CommandFailure>()('CommandFailure', {
  failure: OperationFailure,
}) {}

export const RequestFailure = Schema.Union(
  TransportFailure,
  BrowserFailure,
  ValidationFailure,
  CommandFailure
);
export type RequestFailure = Schema.Schema.Type<typeof RequestFailure>;

export class ItemSucceeded extends Schema.TaggedClass<ItemSucceeded>()('ItemSucceeded', {
  operationId: OperationId,
  itemNumber: HumanItemNumber,
  mediaIdentity: MediaIdentity,
}) {}

export class ItemFailed extends Schema.TaggedClass<ItemFailed>()('ItemFailed', {
  operationId: OperationId,
  itemNumber: HumanItemNumber,
  mediaIdentity: Schema.optional(MediaIdentity),
  failure: OperationFailure,
}) {}

export class ItemSkipped extends Schema.TaggedClass<ItemSkipped>()('ItemSkipped', {
  operationId: OperationId,
  itemNumber: HumanItemNumber,
  code: Schema.Literal('SILENT_REENCODE_DECLINED'),
}) {}

export const ItemOutcome = Schema.Union(ItemSucceeded, ItemFailed, ItemSkipped);
export type ItemOutcome = Schema.Schema.Type<typeof ItemOutcome>;

export class HistoryMarker extends Schema.Class<HistoryMarker>('HistoryMarker')({
  downloaded: Schema.Boolean,
  count: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  latestDownloadedAt: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
}) {}

export class InspectedMedia extends Schema.Class<InspectedMedia>('InspectedMedia')({
  itemNumber: HumanItemNumber,
  mediaIdentity: MediaIdentity,
  mediaType: Schema.Literal('image', 'video'),
  url: Schema.String.pipe(Schema.nonEmptyString()),
  previewUrl: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
  filenameHint: Schema.String.pipe(Schema.nonEmptyString()),
  width: Schema.optional(Schema.Number.pipe(Schema.positive())),
  height: Schema.optional(Schema.Number.pipe(Schema.positive())),
  history: Schema.optional(HistoryMarker),
  creatorUsername: Schema.optional(Schema.String.pipe(Schema.nonEmptyString())),
}) {}

export class InspectResult extends Schema.TaggedClass<InspectResult>()('InspectResult', {
  sourceUrl: Schema.String.pipe(Schema.nonEmptyString()),
  items: Schema.Array(InspectedMedia),
}) {}

export class InstantsInspectResult extends Schema.TaggedClass<InstantsInspectResult>()(
  'InstantsInspectResult',
  { items: Schema.Array(InspectedMedia) }
) {}

export class ExportResult extends Schema.TaggedClass<ExportResult>()('ExportResult', {
  outcomes: Schema.Array(ItemOutcome),
}) {}

export class HistoryEntry extends Schema.Class<HistoryEntry>('HistoryEntry')({
  id: Schema.String.pipe(Schema.nonEmptyString()),
  origin: Schema.Union(
    Schema.Struct({
      kind: Schema.Literal('source'),
      sourceUrl: Schema.String.pipe(Schema.nonEmptyString()),
      sourceKind: Schema.Literal('post', 'reel', 'story', 'highlight', 'profile'),
    }),
    Schema.Struct({ kind: Schema.Literal('instants') })
  ),
  mediaIdentity: MediaIdentity,
  mediaType: Schema.Literal('image', 'video'),
  filenameHint: Schema.String.pipe(Schema.nonEmptyString()),
  exportMode: Schema.optional(Schema.Literal('direct', 'frame', 'silent')),
  frameTimestampSeconds: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  downloadedAt: Schema.Number.pipe(Schema.nonNegative()),
}) {}

export class HistoryListResult extends Schema.TaggedClass<HistoryListResult>()(
  'HistoryListResult',
  {
    entries: Schema.Array(HistoryEntry),
    repaired: Schema.Boolean,
  }
) {}

export class HistoryRemoveResult extends Schema.TaggedClass<HistoryRemoveResult>()(
  'HistoryRemoveResult',
  {
    removedEntryIds: Schema.Array(Schema.String.pipe(Schema.nonEmptyString())),
    unknownEntryIds: Schema.Array(Schema.String.pipe(Schema.nonEmptyString())),
  }
) {}

export class HistoryClearResult extends Schema.TaggedClass<HistoryClearResult>()(
  'HistoryClearResult',
  { clearedCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()) }
) {}

export class HistoryRedownloadStarted extends Schema.TaggedClass<HistoryRedownloadStarted>()(
  'HistoryRedownloadStarted',
  { entryId: Schema.String.pipe(Schema.nonEmptyString()) }
) {}

export class HistoryRedownloadFailed extends Schema.TaggedClass<HistoryRedownloadFailed>()(
  'HistoryRedownloadFailed',
  {
    entryId: Schema.String.pipe(Schema.nonEmptyString()),
    failure: OperationFailure,
  }
) {}

export const HistoryRedownloadOutcome = Schema.Union(
  HistoryRedownloadStarted,
  HistoryRedownloadFailed
);

export class HistoryRedownloadResult extends Schema.TaggedClass<HistoryRedownloadResult>()(
  'HistoryRedownloadResult',
  {
    outcomes: Schema.Array(HistoryRedownloadOutcome),
    unknownEntryIds: Schema.Array(Schema.String.pipe(Schema.nonEmptyString())),
  }
) {}

export class DebugGetResult extends Schema.TaggedClass<DebugGetResult>()('DebugGetResult', {
  diagnosticsVersion: Schema.Literal(2),
  report: Schema.String.pipe(Schema.nonEmptyString()),
}) {}

export class DebugExportResult extends Schema.TaggedClass<DebugExportResult>()(
  'DebugExportResult',
  {
    diagnosticsVersion: Schema.Literal(2),
    filename: Schema.String.pipe(Schema.nonEmptyString()),
    status: Schema.Literal('started'),
  }
) {}

export class StatusResult extends Schema.TaggedClass<StatusResult>()('StatusResult', {
  browser: Schema.Literal('chromium', 'firefox', 'unknown'),
  extensionVersion: Schema.String.pipe(Schema.nonEmptyString()),
  hostVersion: Schema.String.pipe(Schema.nonEmptyString()),
  protocolVersion: Schema.Number.pipe(Schema.int(), Schema.positive()),
  compatible: Schema.Boolean,
}) {}

export class EchoResult extends Schema.TaggedClass<EchoResult>()('EchoResult', {
  value: Schema.Unknown,
}) {}

export const CommandResult = Schema.Union(
  StatusResult,
  EchoResult,
  InspectResult,
  ExportResult,
  HistoryListResult,
  HistoryRemoveResult,
  HistoryClearResult,
  HistoryRedownloadResult,
  DebugGetResult,
  DebugExportResult,
  InstantsInspectResult
);
export type CommandResult = Schema.Schema.Type<typeof CommandResult>;

export class Accepted extends Schema.TaggedClass<Accepted>()('Accepted', {}) {}

export class Progress extends Schema.TaggedClass<Progress>()('Progress', {
  operationId: Schema.optional(OperationId),
  itemNumber: Schema.optional(HumanItemNumber),
  phase: Schema.Literal(
    'resolving',
    'direct-download',
    'frame-metadata',
    'frame-export',
    'silent-inspection',
    'silent-copy',
    'silent-reencode',
    'silent-validation',
    'history',
    'diagnostics'
  ),
  progress: Schema.optional(Schema.Number.pipe(Schema.between(0, 1))),
}) {}

export class Completed extends Schema.TaggedClass<Completed>()('Completed', {
  result: CommandResult,
}) {}

export class Rejected extends Schema.TaggedClass<Rejected>()('Rejected', {
  failure: RequestFailure,
}) {}

export const EventPayload = Schema.Union(Accepted, Progress, Completed, Rejected);
export type EventPayload = Schema.Schema.Type<typeof EventPayload>;

export class Event extends Schema.Class<Event>('Event')({
  version: Schema.Literal(PROTOCOL_VERSION),
  requestId: RequestId,
  event: EventPayload,
}) {}

export const decodeRequest = Schema.decodeUnknown(Request);
export const decodeClientMessage = Schema.decodeUnknown(ClientMessage);
export const decodeEvent = Schema.decodeUnknown(Event);
