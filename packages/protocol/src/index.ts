import { Schema } from 'effect';
import { FailureCodeSchema } from './failures.ts';
import {
  WatchAdd,
  WatchFailureDetail,
  WatchLifecycle,
  WatchList,
  WatchListResult,
  WatchAddResult,
  WatchLifecycleResult,
  WatchSet,
  WatchSetResult,
  WatchShow,
  WatchShowResult,
} from './watch.ts';

export { decodeJsonFrame, encodeFrame, encodeJsonFrame, FrameDecoder } from './framing.ts';
export { localIpcEndpoint, type IpcEnvironment } from './ipc.ts';

export const PROTOCOL_VERSION = 2 as const;

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

/** The clockwise turn applied to an export's output. Absent means unrotated. */
export const Rotation = Schema.Literal(90, 180, 270);
export type Rotation = Schema.Schema.Type<typeof Rotation>;

export class ExportOperation extends Schema.Class<ExportOperation>('ExportOperation')({
  operationId: OperationId,
  itemNumber: HumanItemNumber,
  mediaIdentity: Schema.optional(MediaIdentity),
  mode: ExportMode,
  rotation: Schema.optional(Rotation),
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
  DebugExport,
  WatchList,
  WatchShow,
  WatchAdd,
  WatchSet,
  WatchLifecycle
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

export { FAILURE_CODES, FailureCodeSchema, type FailureCode } from './failures.ts';
export * from './watch.ts';

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

/**
 * Describes an arbitrary thrown value as a ValidationFailure. `message` is non-empty, so
 * constructing one directly from `Error.message` can throw where the throw site cannot recover.
 */
export const validationFailureFrom = (cause: unknown): ValidationFailure =>
  ValidationFailure.make({
    message: (cause instanceof Error ? cause.message : String(cause)) || 'Command failed.',
  });

export class CommandFailure extends Schema.TaggedClass<CommandFailure>()('CommandFailure', {
  failure: OperationFailure,
  detail: Schema.optional(WatchFailureDetail),
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

/**
 * One resolved media item as the background worker hands it to the popup. The popup adds its
 * own display index and selection state on top of this; the CLI receives `InspectedMedia`
 * instead, which restates the same item with human item numbers.
 */
export const MediaItem = Schema.Struct({
  itemIndex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  mediaId: Schema.optional(Schema.String),
  type: Schema.Literal('image', 'video'),
  url: Schema.String.pipe(Schema.nonEmptyString()),
  filenameHint: Schema.String,
  previewUrl: Schema.optional(Schema.String),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  history: Schema.optional(HistoryMarker),
  creatorUsername: Schema.optional(Schema.String),
});
export type MediaItem = Schema.Schema.Type<typeof MediaItem>;

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
  InstantsInspectResult,
  WatchListResult,
  WatchShowResult,
  WatchAddResult,
  WatchSetResult,
  WatchLifecycleResult
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
