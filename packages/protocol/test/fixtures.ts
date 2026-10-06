export const requestId = '3d813cbb-47fb-4ffd-9e5f-91b0e4c37f91';
export const retryRequestId = 'fdb65514-3f27-44c4-b34f-8a6a77f4ec02';
export const operationId = 'ad7a60ff-5e9f-470f-b036-f116e32fda41';

const mediaIdentity = { itemIndex: 0, mediaId: 'stable-media-id' };
const itemFailure = { code: 'MEDIA_NETWORK_FAILED', scope: 'item' };

export const requestFixtures: readonly unknown[] = [
  {
    version: 2,
    requestId,
    command: { _tag: 'Inspect', sourceUrl: 'https://www.instagram.com/p/example/' },
  },
  { version: 2, requestId, command: { _tag: 'InstantsInspect' } },
  {
    version: 2,
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
    version: 2,
    requestId,
    command: {
      _tag: 'InstantsExport',
      operations: [{ operationId, itemNumber: 1, mediaIdentity, mode: { _tag: 'DirectExport' } }],
    },
  },
  { version: 2, requestId, command: { _tag: 'HistoryList' } },
  {
    version: 2,
    requestId,
    command: { _tag: 'HistoryRemove', entryIds: ['history-1'] },
  },
  { version: 2, requestId, command: { _tag: 'HistoryClear' } },
  {
    version: 2,
    requestId,
    command: { _tag: 'HistoryRedownload', entryIds: ['history-1'] },
  },
  { version: 2, requestId, command: { _tag: 'DebugGet' } },
  { version: 2, requestId, command: { _tag: 'DebugExport' } },
  { version: 2, requestId, command: { _tag: 'WatchList' } },
  {
    version: 2,
    requestId,
    command: { _tag: 'WatchShow', watch: { _tag: 'AccountIdSelector', accountId: '2002' } },
  },
  {
    version: 2,
    requestId,
    command: {
      _tag: 'WatchAdd',
      target: 'https://www.instagram.com/example/',
      kinds: ['posts', 'stories'],
      actions: ['notify', 'collect'],
      acceptUnattended: true,
    },
  },
  {
    version: 2,
    requestId,
    command: {
      _tag: 'WatchSet',
      watch: { _tag: 'UsernameSelector', username: 'example' },
      actions: ['download'],
    },
  },
  { version: 2, requestId, command: { _tag: 'WatchCheck' } },
  {
    version: 2,
    requestId,
    command: { _tag: 'WatchInboxList', watch: { _tag: 'AccountIdSelector', accountId: '2002' } },
  },
  { version: 2, requestId, command: { _tag: 'WatchInboxRemove', entryIds: ['entry-1'] } },
  {
    version: 2,
    requestId,
    command: { _tag: 'WatchRecover', action: 'notify', operation: 'retry', entryIds: ['entry-1'] },
  },
  {
    version: 2,
    requestId,
    command: {
      _tag: 'WatchLifecycle',
      operation: 'pause',
      watches: [{ _tag: 'UsernameSelector', username: 'example' }],
    },
  },
];

const watchSummary = {
  watchId: '6f1b2a9e-7c3d-4b8a-9e1f-2a3b4c5d6e7f',
  accountId: '2002',
  username: 'example',
  formerUsername: 'old.example',
  enabled: true,
  kinds: [
    { _tag: 'KindChecked', kind: 'posts', lastSuccessAt: 1_700_000_000_000 },
    { _tag: 'KindBaselinePending', kind: 'stories' },
    { _tag: 'KindOff', kind: 'instants', baselineKept: true },
    {
      _tag: 'KindProblem',
      kind: 'avatar',
      code: 'WATCH_USERNAME_UNCONFIRMED',
      since: 1_700_000_000_000,
    },
  ],
  actions: ['notify', 'collect'],
  attentionCount: 1,
  inboxCount: 2,
  createdAt: 1_690_000_000_000,
  lastCheckAt: 1_700_000_000_000,
};

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
  { _tag: 'DebugGetResult', diagnosticsVersion: 2, report: '{"diagnosticsVersion":2}' },
  {
    _tag: 'DebugExportResult',
    diagnosticsVersion: 2,
    filename: 'gramgrab-diagnostics.json',
    status: 'started',
  },
  {
    _tag: 'WatchListResult',
    viewer: { accountId: '1001', username: 'viewer' },
    schedule: {
      nextRoundAt: 1_700_043_200_000,
      roundRemaining: 2,
      pausedUntil: 1_700_001_800_000,
      suspended: false,
    },
    otherLoginWatchCount: 1,
    storage: { usedBytes: 2048, budgetBytes: 2_097_152, status: 'ok' },
    attentionCount: 2,
    watches: [watchSummary],
    attentionEntries: [
      {
        entryId: 'd4b2f3e5-6c7a-4b8d-9eaf-1a2b3c4d5e6f',
        watchId: watchSummary.watchId,
        accountId: '2002',
        username: 'example',
        kind: 'avatar',
        mediaType: 'avatar',
        discoveredAt: 1_700_000_000_000,
        notify: { state: 'failed', code: 'WATCH_NOTIFY_PERMISSION_DENIED' },
      },
    ],
  },
  {
    _tag: 'WatchShowResult',
    watch: watchSummary,
    discoveries: [
      {
        entryId: 'c3a1e2d4-5b6f-4a7c-8d9e-0f1a2b3c4d5e',
        watchId: watchSummary.watchId,
        accountId: '2002',
        username: 'example',
        kind: 'posts',
        mediaType: 'sidecar',
        childCount: 3,
        discoveredAt: 1_700_000_000_000,
        inboxUntil: 1_702_592_000_000,
        missingChildren: 1,
        notify: { state: 'done' },
        download: { state: 'failed', code: 'BROWSER_DOWNLOAD_NETWORK_FAILED' },
        collect: { state: 'done' },
      },
    ],
  },
  {
    _tag: 'WatchCheckResult',
    outcomes: [
      {
        watchId: watchSummary.watchId,
        accountId: '2002',
        username: 'example',
        kinds: [
          { _tag: 'KindBaselineRecorded', kind: 'stories' },
          { _tag: 'KindCheckSucceeded', kind: 'posts', newCount: 2, catchUp: true },
          { _tag: 'KindCheckFailed', kind: 'avatar', code: 'WATCH_USERNAME_UNCONFIRMED' },
          { _tag: 'KindCheckSkipped', kind: 'instants', reason: 'deferred' },
        ],
        deferredUntil: 1_700_000_100_000,
      },
    ],
    unknownWatches: ['missing'],
  },
  { _tag: 'WatchInboxListResult', entries: [] },
  { _tag: 'WatchInboxRemoveResult', removedEntryIds: ['a'], unknownEntryIds: ['b'] },
  {
    _tag: 'WatchRecoverResult',
    recoveredEntryIds: ['a'],
    refused: [{ entryId: 'b', code: 'WATCH_RECOVERY_NOT_APPLICABLE' }],
    unknownEntryIds: ['c'],
  },
  { _tag: 'WatchAddResult', created: false, watch: watchSummary },
  { _tag: 'WatchSetResult', watch: watchSummary, baselineKinds: ['stories'] },
  {
    _tag: 'WatchLifecycleResult',
    operation: 'pause',
    watches: [watchSummary],
    unknownWatches: ['missing'],
  },
];

export const eventFixtures: readonly unknown[] = [
  { version: 2, requestId, event: { _tag: 'Accepted' } },
  {
    version: 2,
    requestId,
    event: {
      _tag: 'Progress',
      phase: 'watch-check',
      watchCheck: {
        watchId: operationId,
        kind: 'stories',
        outcome: { _tag: 'KindBaselineRecorded', kind: 'stories' },
      },
    },
  },
  {
    version: 2,
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
    version: 2,
    requestId,
    event: { _tag: 'Completed', result },
  })),
  {
    version: 2,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: { _tag: 'TransportFailure', code: 'IPC_DISCONNECTED' },
    },
  },
  {
    version: 2,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: { _tag: 'BrowserFailure', code: 'EXTENSION_UNAVAILABLE' },
    },
  },
  {
    version: 2,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: { _tag: 'ValidationFailure', message: 'Invalid request' },
    },
  },
  {
    version: 2,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: {
        _tag: 'CommandFailure',
        failure: { code: 'SOURCE_MEDIA_NOT_FOUND', scope: 'batch' },
      },
    },
  },
  ...[
    { _tag: 'StoredWatchCount', count: 3 },
    { _tag: 'UnattendedDisclosure', text: 'Watches check Instagram for you.' },
    { _tag: 'ExistingWatch', accountId: '2002', username: 'example' },
  ].map(detail => ({
    version: 2,
    requestId,
    event: {
      _tag: 'Rejected',
      failure: {
        _tag: 'CommandFailure',
        failure: { code: 'WATCH_CONFIG_CONFLICT', scope: 'batch' },
        detail,
      },
    },
  })),
];
