export const requestId = '3d813cbb-47fb-4ffd-9e5f-91b0e4c37f91';
export const retryRequestId = 'fdb65514-3f27-44c4-b34f-8a6a77f4ec02';
export const operationId = 'ad7a60ff-5e9f-470f-b036-f116e32fda41';

const mediaIdentity = { itemIndex: 0, mediaId: 'stable-media-id' };
const itemFailure = { code: 'MEDIA_NETWORK_FAILED', scope: 'item' };

export const requestFixtures: readonly unknown[] = [
  {
    version: 1,
    requestId,
    command: { _tag: 'Inspect', sourceUrl: 'https://www.instagram.com/p/example/' },
  },
  { version: 1, requestId, command: { _tag: 'InstantsInspect' } },
  {
    version: 1,
    requestId,
    command: {
      _tag: 'Export',
      sourceUrl: 'https://www.instagram.com/p/example/',
      operations: [
        { operationId, itemNumber: 1, mediaIdentity, mode: { _tag: 'DirectExport' } },
        {
          operationId: '41645d23-ddad-45e7-ac3c-a3c83fefacfa',
          itemNumber: 2,
          mode: { _tag: 'FrameExport', timestampSeconds: 7 },
        },
        {
          operationId: '70af457d-81a3-4d15-bb85-e7a0c7320e31',
          itemNumber: 3,
          mode: { _tag: 'SilentExport', reencode: 'allow' },
        },
      ],
    },
  },
  {
    version: 1,
    requestId,
    command: {
      _tag: 'InstantsExport',
      operations: [{ operationId, itemNumber: 1, mediaIdentity, mode: { _tag: 'DirectExport' } }],
    },
  },
  { version: 1, requestId, command: { _tag: 'HistoryList' } },
  {
    version: 1,
    requestId,
    command: { _tag: 'HistoryRemove', entryIds: ['history-1'] },
  },
  { version: 1, requestId, command: { _tag: 'HistoryClear' } },
  {
    version: 1,
    requestId,
    command: { _tag: 'HistoryRedownload', entryIds: ['history-1'] },
  },
  { version: 1, requestId, command: { _tag: 'DebugGet' } },
  { version: 1, requestId, command: { _tag: 'DebugExport' } },
];

const resultFixtures: readonly unknown[] = [
  {
    _tag: 'InspectResult',
    sourceUrl: 'https://www.instagram.com/p/example/',
    items: [
      {
        itemNumber: 1,
        mediaIdentity,
        mediaType: 'video',
        url: 'https://cdn.example/video.mp4',
        previewUrl: 'https://cdn.example/preview.jpg',
        filenameHint: 'example.mp4',
        width: 1080,
        height: 1920,
        history: { downloaded: true, count: 1, latestDownloadedAt: 1_700_000_000_000 },
      },
    ],
  },
  {
    _tag: 'InstantsInspectResult',
    items: [
      {
        itemNumber: 1,
        mediaIdentity,
        mediaType: 'image',
        url: 'https://cdn.example/instant.jpg',
        filenameHint: 'creator_instant_1',
        creatorUsername: 'creator',
      },
    ],
  },
  {
    _tag: 'ExportResult',
    outcomes: [
      { _tag: 'ItemSucceeded', operationId, itemNumber: 1, mediaIdentity },
      {
        _tag: 'ItemFailed',
        operationId: '41645d23-ddad-45e7-ac3c-a3c83fefacfa',
        itemNumber: 2,
        failure: itemFailure,
      },
      {
        _tag: 'ItemSkipped',
        operationId: '70af457d-81a3-4d15-bb85-e7a0c7320e31',
        itemNumber: 3,
        code: 'SILENT_REENCODE_DECLINED',
      },
    ],
  },
  {
    _tag: 'HistoryListResult',
    repaired: false,
    entries: [
      {
        id: 'history-1',
        origin: {
          kind: 'source',
          sourceUrl: 'https://www.instagram.com/p/example/',
          sourceKind: 'post',
        },
        mediaIdentity,
        mediaType: 'video',
        filenameHint: 'example.mp4',
        exportMode: 'silent',
        downloadedAt: 1_700_000_000_000,
      },
    ],
  },
  {
    _tag: 'HistoryRemoveResult',
    removedEntryIds: ['history-1'],
    unknownEntryIds: ['missing-history'],
  },
  { _tag: 'HistoryClearResult', clearedCount: 4 },
  {
    _tag: 'HistoryRedownloadResult',
    outcomes: [
      { _tag: 'HistoryRedownloadStarted', entryId: 'history-1' },
      { _tag: 'HistoryRedownloadFailed', entryId: 'history-2', failure: itemFailure },
    ],
    unknownEntryIds: ['missing-history'],
  },
  { _tag: 'DebugGetResult', diagnosticsVersion: 1, report: '{"diagnosticsVersion":1}' },
  {
    _tag: 'DebugExportResult',
    diagnosticsVersion: 1,
    filename: 'gramgrab-diagnostics.json',
    status: 'started',
  },
];

export const eventFixtures: readonly unknown[] = [
  { version: 1, requestId, event: { _tag: 'Accepted' } },
  {
    version: 1,
    requestId,
    event: {
      _tag: 'Progress',
      operationId,
      itemNumber: 1,
      phase: 'silent-copy',
      progress: 0.5,
    },
  },
  ...resultFixtures.map(result => ({
    version: 1,
    requestId,
    event: { _tag: 'Completed', result },
  })),
  {
    version: 1,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: { _tag: 'TransportFailure', code: 'IPC_DISCONNECTED' },
    },
  },
  {
    version: 1,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: { _tag: 'BrowserFailure', code: 'EXTENSION_UNAVAILABLE' },
    },
  },
  {
    version: 1,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: { _tag: 'ValidationFailure', message: 'Invalid request' },
    },
  },
  {
    version: 1,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: {
        _tag: 'CommandFailure',
        failure: { code: 'SOURCE_MEDIA_NOT_FOUND', scope: 'batch' },
      },
    },
  },
];
