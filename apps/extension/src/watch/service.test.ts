import { Schema } from 'effect';
import { WatchStore } from './contracts.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  AccountIdSelector,
  UNATTENDED_DISCLOSURE,
  UsernameSelector,
  WatchAdd,
  WatchLifecycle,
  WatchList,
  WatchSet,
  WatchShow,
  WatchesExport,
  WatchesImport,
  type CommandFailure,
  type WatchDefinition,
  type WatchCommand,
} from '@gramgrab/protocol';
import { createExtensionHarness, json, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, VIEWER, createWatchInstagram } from '../test/watch-instagram.ts';
import type { WatchCommandResponse, WatchPreviewResponse } from '../messaging/contracts.ts';

let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

beforeEach(async () => {
  harness = createExtensionHarness();
  instagram = createWatchInstagram();
  harness.setFetch(instagram.handle);
  await harness.loadWorker();
});

afterEach(() => {
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

const run = (command: WatchCommand) =>
  harness.send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command });

const failureOf = (response: WatchCommandResponse | WatchPreviewResponse) =>
  response.failure?._tag === 'CommandFailure' ? (response.failure as CommandFailure) : undefined;

const addTarget = (overrides: Partial<ConstructorParameters<typeof WatchAdd>[0]> = {}) =>
  run(
    WatchAdd.make({
      target: TARGET.username,
      kinds: ['stories', 'posts'],
      actions: ['collect'],
      acceptUnattended: true,
      ...overrides,
    })
  );

const storedWatches = () =>
  (harness.local.read('watch-store') as { watches: { username: string; viewerId: string }[] })
    .watches;

describe('adding a Watch', () => {
  it('requires the disclosure acknowledgement on every add, before any request', async () => {
    const response = await addTarget({ acceptUnattended: false });

    expect(failureOf(response)?.failure.code).toBe('WATCH_UNATTENDED_NOT_ACCEPTED');
    expect(failureOf(response)?.detail).toEqual({
      _tag: 'UnattendedDisclosure',
      text: UNATTENDED_DISCLOSURE,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('follows the confirmed account ID and starts every kind pending its baseline', async () => {
    const response = await addTarget({ target: `https://www.instagram.com/${TARGET.username}/` });

    expect(response.result?._tag).toBe('WatchAddResult');
    if (response.result?._tag !== 'WatchAddResult') return;
    expect(response.result.created).toBe(true);
    expect(response.result.watch).toMatchObject({
      accountId: TARGET.id,
      username: TARGET.username,
      enabled: true,
    });
    expect(response.result.watch.kinds.map(kind => [kind.kind, kind._tag])).toEqual([
      ['posts', 'KindBaselinePending'],
      ['stories', 'KindBaselinePending'],
      ['instants', 'KindOff'],
      ['avatar', 'KindOff'],
    ]);
    expect(storedWatches()).toMatchObject([{ viewerId: VIEWER.id, username: TARGET.username }]);
  });

  it('refuses a username the ID-keyed profile cannot confirm', async () => {
    instagram.state.profile = { data: { user: { id: '9999', username: TARGET.username } } };
    expect(failureOf(await addTarget())?.failure.code).toBe('WATCH_USERNAME_UNCONFIRMED');

    instagram.state.profile = {
      data: { user: { id: TARGET.id, username: TARGET.username } },
      errors: [{ message: 'placeholder' }],
    };
    expect(failureOf(await addTarget())?.failure.code).toBe('WATCH_USERNAME_UNCONFIRMED');
    expect(harness.local.read('watch-store')).toBeUndefined();
  });

  it('returns the existing Watch for an identical add and points a different one at set', async () => {
    await addTarget();

    const again = await addTarget({ kinds: ['posts', 'stories'] });
    expect(again.result?._tag === 'WatchAddResult' && again.result.created).toBe(false);

    const conflict = await addTarget({ actions: ['notify'] });
    expect(failureOf(conflict)?.failure.code).toBe('WATCH_CONFIG_CONFLICT');
    expect(failureOf(conflict)?.detail).toEqual({
      _tag: 'ExistingWatch',
      accountId: TARGET.id,
      username: TARGET.username,
    });
    expect(storedWatches()).toHaveLength(1);
  });

  it('previews the resolved account and the Watch adding it would open', async () => {
    const before = await harness.send<WatchPreviewResponse>({
      type: 'WATCH_PREVIEW',
      target: `@${TARGET.username}`,
    });
    expect(before.account).toEqual({ accountId: TARGET.id, username: TARGET.username });
    expect(before.account && before.existing).toBeUndefined();

    await addTarget();
    const after = await harness.send<WatchPreviewResponse>({
      type: 'WATCH_PREVIEW',
      target: TARGET.username,
    });
    expect(after.account && after.existing?.accountId).toBe(TARGET.id);
  });
});

describe('owner-bound access', () => {
  it('shows another login only the count of Watches it does not own', async () => {
    await addTarget();
    instagram.state.viewer = { id: '3003', username: 'someone.else' };

    const listed = await run(WatchList.make());
    expect(listed.result?._tag === 'WatchListResult' && listed.result).toMatchObject({
      viewer: { accountId: '3003' },
      otherLoginWatchCount: 1,
      watches: [],
    });
    const shown = await run(
      WatchShow.make({ watch: AccountIdSelector.make({ accountId: TARGET.id }) })
    );
    expect(failureOf(shown)?.failure.code).toBe('WATCH_NOT_FOUND');
  });

  it('exposes only the stored count without a verified login', async () => {
    await addTarget();
    instagram.state.viewer = null;

    for (const command of [
      WatchList.make(),
      WatchShow.make({ watch: UsernameSelector.make({ username: TARGET.username }) }),
    ]) {
      const response = await run(command);
      expect(failureOf(response)?.failure.code).toBe('IG_NOT_AUTHENTICATED');
      expect(failureOf(response)?.detail).toEqual({ _tag: 'StoredWatchCount', count: 1 });
    }
  });

  it('keeps malformed, refused, and offline viewer queries behind the authentication gate', async () => {
    await addTarget();
    for (const handle of [
      () => json({ data: {} }),
      () => Promise.resolve(new Response(null, { status: 503 })),
      () => Promise.reject(new Error('offline')),
    ]) {
      harness.setFetch(handle);
      const response = await run(WatchList.make());
      expect(failureOf(response)?.failure.code).toBe('IG_NOT_AUTHENTICATED');
      expect(failureOf(response)?.detail).toEqual({ _tag: 'StoredWatchCount', count: 1 });
      expect(response.result).toBeUndefined();
    }
  });

  it('does not authorize a partial viewer response with GraphQL errors', async () => {
    await addTarget();
    harness.setFetch(() =>
      json({
        data: { user: { id: VIEWER.id, username: VIEWER.username } },
        errors: [{ message: 'request rejected' }],
      })
    );
    const response = await run(WatchList.make());
    expect(failureOf(response)?.failure.code).toBe('IG_NOT_AUTHENTICATED');
    expect(failureOf(response)?.detail).toEqual({ _tag: 'StoredWatchCount', count: 1 });
    expect(response.result).toBeUndefined();
  });
});

describe('editing a Watch', () => {
  it('replaces kinds and actions and keeps initialized baselines', async () => {
    await addTarget();
    const stored = harness.local.read('watch-store') as {
      watches: { tracking: Record<string, unknown> }[];
    };
    stored.watches[0]!.tracking = { stories: { baselineCutoff: 100, lastSuccessAt: 1 } };
    harness.local.write('watch-store', stored);
    const selector = UsernameSelector.make({ username: TARGET.username });

    const narrowed = await run(WatchSet.make({ watch: selector, kinds: ['posts'] }));
    expect(narrowed.result?._tag === 'WatchSetResult' && narrowed.result.baselineKinds).toEqual([]);
    const widened = await run(
      WatchSet.make({ watch: selector, kinds: ['stories', 'avatar'], actions: ['notify'] })
    );

    expect(widened.result?._tag === 'WatchSetResult' && widened.result).toMatchObject({
      baselineKinds: ['avatar'],
      watch: { actions: ['notify'] },
    });
    if (widened.result?._tag !== 'WatchSetResult') return;
    expect(widened.result.watch.kinds.find(kind => kind.kind === 'stories')?._tag).toBe(
      'KindChecked'
    );
  });

  it('pauses, resumes, and deletes several Watches and reports unknown selectors', async () => {
    await addTarget();
    const selectors = [
      AccountIdSelector.make({ accountId: TARGET.id }),
      UsernameSelector.make({ username: 'nobody' }),
    ] as const;

    const paused = await run(WatchLifecycle.make({ operation: 'pause', watches: selectors }));
    expect(paused.result?._tag === 'WatchLifecycleResult' && paused.result).toMatchObject({
      watches: [{ enabled: false }],
      unknownWatches: ['nobody'],
    });
    await run(WatchLifecycle.make({ operation: 'delete', watches: selectors }));

    expect(storedWatches()).toEqual([]);
    const readded = await addTarget();
    expect(readded.result?._tag === 'WatchAddResult' && readded.result.created).toBe(true);
  });
});

describe('moving Watches to another install', () => {
  const definition = (overrides: Partial<WatchDefinition> = {}): WatchDefinition => ({
    accountId: TARGET.id,
    username: TARGET.username,
    enabled: true,
    kinds: ['stories', 'posts'],
    actions: ['collect'],
    ...overrides,
  });
  const importFile = (watches: readonly WatchDefinition[], acceptUnattended = true) =>
    run(
      WatchesImport.make({
        file: { format: 'gramgrab-watches', version: 1, watches },
        acceptUnattended,
      })
    );

  it('exports only the account and settings of each Watch the login owns', async () => {
    await addTarget();
    const store = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
    const mine = store.watches[0]!;
    harness.local.write('watch-store', {
      ...store,
      watches: [
        {
          ...mine,
          enabled: false,
          tracking: { stories: { baselineCutoff: 5, lastSuccessAt: 6, lastCheckAt: 6 } },
          avatarImage: { pictureId: 'PIC_A', jpeg: '/9j/2Q==', checkedAt: 1 },
          discoveries: [
            {
              id: '0b8e3d5c-2a4f-4e6b-9c1d-7f8a9b0c1d2e',
              checkId: '1c9f4e6d-3b5a-4f7c-8d2e-8a9b0c1d2e3f',
              ref: { _tag: 'Avatar', pictureId: 'PIC_A' },
              discoveredAt: 6,
              collect: { at: 6 },
            },
          ],
        },
        { ...mine, id: '00000000-0000-4000-8000-000000000001', viewerId: '3003' },
      ],
    });

    const exported = await run(WatchesExport.make());

    expect(exported.result).toEqual({
      _tag: 'WatchesExportResult',
      file: {
        format: 'gramgrab-watches',
        version: 1,
        watches: [definition({ enabled: false })],
      },
    });
  });

  it('requires the disclosure acknowledgement before importing, before any request', async () => {
    const response = await importFile([definition()], false);

    expect(failureOf(response)?.failure.code).toBe('WATCH_UNATTENDED_NOT_ACCEPTED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  /** Answers the ID-keyed profile query per account: a username confirms it, a status fails it. */
  function answerProfiles(answers: Record<string, string | number>) {
    const requested: string[] = [];
    harness.setFetch((url, init) => {
      const body = init?.body;
      if (!(body instanceof URLSearchParams) || body.get('doc_id') !== '28036671149327607')
        return instagram.handle(url, init);
      const id = String(JSON.parse(body.get('variables') ?? '{}').id);
      requested.push(id);
      const answer = answers[id];
      return typeof answer === 'number'
        ? json({}, answer)
        : json({ data: { user: answer ? { id, pk: id, username: answer } : null } });
    });
    return requested;
  }

  it('imports confirmed accounts with a fresh baseline and leaves a Watch it has alone', async () => {
    await addTarget();
    const before = storedWatches();
    const requested = answerProfiles({ '4004': 'instagram.renamed' });

    const imported = await importFile([
      definition({ kinds: ['avatar'], actions: ['notify'] }),
      definition({ accountId: '4004', enabled: false, kinds: ['instants'] }),
      definition({ accountId: '5005' }),
    ]);

    expect(imported.result).toMatchObject({
      _tag: 'WatchesImportResult',
      added: [{ accountId: '4004', username: 'instagram.renamed', enabled: false }],
      unconfirmed: ['5005'],
    });
    expect(storedWatches()).toEqual([
      before[0],
      expect.objectContaining({
        viewerId: VIEWER.id,
        targetId: '4004',
        username: 'instagram.renamed',
        enabled: false,
        kinds: ['instants'],
        actions: ['collect'],
        tracking: {},
        discoveries: [],
      }),
    ]);
    expect(requested).toEqual(['4004', '5005']);
  });

  it('stops at a failed request, keeps what it confirmed, and says how many are left', async () => {
    const requested = answerProfiles({ '4004': 'instagram', '5005': 429, '6006': 'instagram' });

    const imported = await importFile(
      ['4004', '5005', '6006'].map(accountId => definition({ accountId }))
    );

    expect(imported.result).toMatchObject({
      added: [{ accountId: '4004' }],
      unconfirmed: [],
      stopped: { code: 'IG_RATE_LIMITED', remaining: 2 },
    });
    expect(storedWatches()).toMatchObject([{ targetId: '4004' }]);
    expect(requested).not.toContain('6006');
  });
});

describe('Watch storage', () => {
  it('keeps an unreadable store untouched and reports it instead of resetting', async () => {
    harness.local.write('watch-store', { version: 1, watches: [{ id: 'broken' }] });

    const added = await addTarget();
    const listed = await run(WatchList.make());

    expect(failureOf(added)?.failure.code).toBe('WATCH_STORE_UNREADABLE');
    expect(listed.result?._tag === 'WatchListResult' && listed.result.storage.status).toBe(
      'unreadable'
    );
    expect(harness.local.read('watch-store')).toEqual({
      version: 1,
      watches: [{ id: 'broken' }],
    });
  });

  it('refuses a newer store version without reading it as empty', async () => {
    harness.local.write('watch-store', { version: 2, watches: [] });
    expect(failureOf(await addTarget())?.failure.code).toBe('WATCH_STORE_VERSION_UNSUPPORTED');
  });

  it('rejects account, media, and session data at every persisted boundary without resetting it', async () => {
    await addTarget();
    const stored = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
    const watch = stored.watches[0]!;
    const discovery = {
      id: '00000000-0000-4000-8000-000000000001',
      checkId: '00000000-0000-4000-8000-000000000002',
      ref: {
        _tag: 'Sidecar',
        mediaId: '31',
        shortcode: 'TEST',
        takenAt: 2,
        children: [{ mediaId: '32', mediaType: 'image' }],
      },
      discoveredAt: Date.now(),
      download: { children: [{ status: 'pending' }], dismissed: false },
      manualExport: {
        id: '00000000-0000-4000-8000-000000000003',
        children: [
          {
            operationId: '00000000-0000-4000-8000-000000000004',
            requested: { mode: { _tag: 'DirectExport' } },
            state: 'pending',
          },
        ],
      },
    };
    const valid = Schema.decodeUnknownSync(WatchStore)({
      ...stored,
      watches: [
        {
          ...watch,
          tracking: { stories: { baselineCutoff: 1 } },
          discoveries: [discovery],
        },
      ],
    });
    const forbidden = {
      caption: 'caption-secret',
      url: 'https://example.invalid/media',
      cookie: 'session-secret',
      bytes: [1, 2, 3],
      displayName: 'name-secret',
    };
    for (const contaminate of [
      (value: Schema.Schema.Encoded<typeof WatchStore>) => Object.assign(value, forbidden),
      (value: Schema.Schema.Encoded<typeof WatchStore>) =>
        Object.assign(value.watches[0]!, forbidden),
      (value: Schema.Schema.Encoded<typeof WatchStore>) =>
        Object.assign(value.watches[0]!.tracking.stories!, forbidden),
      (value: Schema.Schema.Encoded<typeof WatchStore>) =>
        Object.assign(value.watches[0]!.discoveries[0]!.ref, forbidden),
      (value: Schema.Schema.Encoded<typeof WatchStore>) =>
        Object.assign(value.watches[0]!.discoveries[0]!.download!.children[0]!, forbidden),
      (value: Schema.Schema.Encoded<typeof WatchStore>) =>
        Object.assign(
          value.watches[0]!.discoveries[0]!.manualExport!.children[0]!.requested,
          forbidden
        ),
    ]) {
      const encoded = Schema.encodeSync(WatchStore)(valid);
      contaminate(encoded);
      harness.local.write('watch-store', encoded);
      const listed = await run(WatchList.make());
      expect(listed.result?._tag === 'WatchListResult' && listed.result.storage.status).toBe(
        'unreadable'
      );
      expect(harness.local.read('watch-store')).toEqual(encoded);
      expect(failureOf(await addTarget())?.failure.code).toBe('WATCH_STORE_UNREADABLE');
      expect(harness.local.read('watch-store')).toEqual(encoded);
    }
  });

  it('reports a browser write rejection below the byte budget as a store failure', async () => {
    harness.local.failWrites = true;

    expect(failureOf(await addTarget())?.failure.code).toBe('WATCH_STORE_FAILED');
    harness.local.failWrites = false;
    const listed = await run(WatchList.make());
    expect(listed.result?._tag === 'WatchListResult' && listed.result.storage.status).toBe(
      'write-failed'
    );
    await addTarget();
    const recovered = await run(WatchList.make());
    expect(recovered.result?._tag === 'WatchListResult' && recovered.result.storage.status).toBe(
      'ok'
    );
  });
});
