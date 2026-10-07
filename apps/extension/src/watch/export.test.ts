import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  FrameExport,
  SilentExport,
  WatchAdd,
  WatchCheck,
  WatchInboxExport,
  WatchInboxRetry,
  WatchInboxList,
  type WatchCommand,
  type WatchKind,
  type WatchResult,
} from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import {
  TARGET,
  avatarSearch,
  createWatchInstagram,
  instantsFeed,
  postsPage,
  restMedia,
  storyResponse,
  type FakePost,
} from '../test/watch-instagram.ts';
import type { MessageResponse, WatchCommandResponse } from '../messaging/contracts.ts';
import { processingBrowser, silentBrowser } from '../test/processing-browser.ts';

const START = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;

let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  harness = createExtensionHarness();
  instagram = createWatchInstagram();
  harness.setFetch(instagram.handle);
  await harness.loadWorker();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

/** Sends a Watch command and lets paced requests run on the fake clock until it answers. */
async function run<T extends WatchResult['_tag']>(command: WatchCommand, expected: T) {
  let response: WatchCommandResponse | undefined;
  void harness
    .send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command })
    .then(answer => (response = answer));
  while (!response) await vi.advanceTimersByTimeAsync(1_000);
  if (response.result?._tag !== expected)
    throw new Error(`Expected ${expected}, got ${JSON.stringify(response)}`);
  return response.result as Extract<WatchResult, { _tag: T }>;
}

async function previewEntry(entryId: string) {
  let response: MessageResponse<'WATCH_INBOX_PREVIEW'> | undefined;
  void harness
    .send<MessageResponse<'WATCH_INBOX_PREVIEW'>>({ type: 'WATCH_INBOX_PREVIEW', entryId })
    .then(answer => {
      response = answer;
    });
  while (!response) await vi.advanceTimersByTimeAsync(1_000);
  return response;
}

const seconds = (time: number) => Math.floor(time / 1000);

/** Adds a collecting Watch of `kind`, records its baseline, and returns the baseline second. */
async function watching(kind: WatchKind) {
  await run(
    WatchAdd.make({
      target: TARGET.username,
      kinds: [kind],
      actions: ['collect'],
      acceptUnattended: true,
    }),
    'WatchAddResult'
  );
  await check();
  return seconds(Date.now());
}

/** Runs a check once the five-minute manual-check interval has passed. */
async function check() {
  await vi.advanceTimersByTimeAsync(5 * MINUTE);
  await run(
    WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: TARGET.id })] }),
    'WatchCheckResult'
  );
}

const inbox = async () => (await run(WatchInboxList.make({}), 'WatchInboxListResult')).entries;

const exportEntries = (...entryIds: readonly string[]) =>
  run(
    WatchInboxExport.make({ entryIds: [entryIds[0]!, ...entryIds.slice(1)] }),
    'WatchInboxExportResult'
  );

const history = async () =>
  (await harness.send<MessageResponse<'GET_DOWNLOAD_HISTORY'>>({ type: 'GET_DOWNLOAD_HISTORY' }))
    .entries;

/** Discovers `post` through a Posts check and returns its inbox entry ID. */
async function discoverPost(post: Omit<FakePost, 'takenAt'>) {
  const cutoff = await watching('posts');
  const found = { ...post, takenAt: cutoff + 60 };
  instagram.state.posts = { '': postsPage([found]) };
  await check();
  return { entryId: (await inbox())[0]!.entryId, post: found };
}

describe('Watch inbox Export', () => {
  it('previews exact recorded children without downloading, creating a plan or writing History', async () => {
    const { entryId, post } = await discoverPost({ id: '600', children: ['601', '602'] });
    instagram.state.media.C600 = restMedia({ ...post, children: ['601', '603'] });
    const before = harness.local.read('watch-store');
    const preview = await previewEntry(entryId);
    expect(preview.media?.map(item => [item.itemIndex, item.mediaId])).toEqual([[0, '601']]);
    expect(preview.unavailable).toEqual([{ child: 1, code: 'WATCH_MEDIA_UNAVAILABLE' }]);
    expect(harness.local.read('watch-store')).toEqual(before);
    expect(harness.downloads).toEqual([]);
    expect(await history()).toEqual([]);
  });

  it('reacquires at download time and refuses a child removed since preview', async () => {
    const { entryId, post } = await discoverPost({ id: '600', children: ['601', '602'] });
    instagram.state.media.C600 = restMedia(post);
    expect((await previewEntry(entryId)).media).toHaveLength(2);
    instagram.state.media.C600 = restMedia({ ...post, children: ['601', '603'] });
    const result = await run(
      WatchInboxExport.make({
        entryIds: [entryId],
        items: [
          {
            entryId,
            child: 1,
            settings: { mode: FrameExport.make({ timestampSeconds: 5 }) },
          },
        ],
      }),
      'WatchInboxExportResult'
    );
    expect(result.outcomes[0]).toMatchObject({
      accepted: 0,
      failures: [{ child: 1, code: 'WATCH_MEDIA_UNAVAILABLE' }],
    });
    expect(harness.downloads).toEqual([]);
  });

  it('rejects duplicate or out-of-range selections before fetching recorded media', async () => {
    const { entryId } = await discoverPost({ id: '600', children: ['601', '602'] });
    const item = {
      entryId,
      child: 0,
      settings: { mode: FrameExport.make({ timestampSeconds: 5 }) },
    };
    for (const items of [[item, item], [{ ...item, child: 2 }]]) {
      const result = await run(
        WatchInboxExport.make({ entryIds: [entryId], items }),
        'WatchInboxExportResult'
      );
      expect(result.outcomes[0]?.failures).toEqual([{ code: 'WATCH_RECOVERY_NOT_APPLICABLE' }]);
    }
    expect(instagram.state.mediaRequests).toBe(0);
  });

  it('runs Frame with rotation through the real runner and writes requested and delivered History', async () => {
    const { entryId, post } = await discoverPost({ id: '200', video: true });
    instagram.state.media.C200 = restMedia(post);
    const { seek, context } = await processingBrowser(harness, instagram);
    const result = await run(
      WatchInboxExport.make({
        entryIds: [entryId],
        settings: { mode: FrameExport.make({ timestampSeconds: 8.5 }), rotation: 90 },
      }),
      'WatchInboxExportResult'
    );
    expect(result.outcomes[0]).toMatchObject({ accepted: 1, failures: [] });
    expect(seek).toHaveBeenCalledWith(8.5);
    expect(context.rotate).toHaveBeenCalledWith(Math.PI / 2);
    expect(await history()).toMatchObject([
      {
        exportMode: 'frame',
        frameTimestampSeconds: 8.5,
        rotation: 90,
        requestedExport: { mode: { _tag: 'FrameExport', timestampSeconds: 8.5 }, rotation: 90 },
      },
    ]);
    expect(harness.browser.tabs.create).not.toHaveBeenCalled();
    expect(harness.local.read('workspace-snapshot')).toBeUndefined();
    expect(await inbox()).toHaveLength(1);
  });

  it('retries the frozen failed child after processing failure without repeating accepted siblings', async () => {
    const { entryId, post } = await discoverPost({ id: '210', children: ['211', '212'] });
    instagram.state.media.C210 = restMedia(post);
    const { seek } = await processingBrowser(harness, instagram);
    const download = vi.mocked(harness.browser.downloads.download);
    download
      .mockImplementationOnce(download.getMockImplementation()!)
      .mockRejectedValueOnce(new Error('network failure'));
    const result = await run(
      WatchInboxExport.make({
        entryIds: [entryId],
        settings: { mode: FrameExport.make({ timestampSeconds: 9 }) },
      }),
      'WatchInboxExportResult'
    );
    expect(result.outcomes[0]).toMatchObject({
      accepted: 1,
      failures: [{ child: 1, code: 'BROWSER_DOWNLOAD_NETWORK_FAILED' }],
    });

    const retried = await run(
      WatchInboxRetry.make({ plans: [{ entryId, planId: result.outcomes[0]!.planId! }] }),
      'WatchInboxExportResult'
    );
    expect(retried.outcomes[0]).toMatchObject({ accepted: 2, failures: [] });
    expect(harness.downloads).toHaveLength(2);
    expect(seek.mock.calls.every(([second]) => second === 9)).toBe(true);
    expect(await history()).toMatchObject([
      { exportMode: 'frame', frameTimestampSeconds: 9 },
      { exportMode: 'direct' },
    ]);
  });

  it('offers only applicable recovery and delivers Original without the failed rotation', async () => {
    const { entryId, post } = await discoverPost({ id: '215', video: true });
    instagram.state.media.C215 = restMedia(post);
    await processingBrowser(harness, instagram);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const result = await run(
      WatchInboxExport.make({
        entryIds: [entryId],
        settings: {
          mode: FrameExport.make({ timestampSeconds: 4 }),
          rotation: 90,
        },
      }),
      'WatchInboxExportResult'
    );
    const plans = [{ entryId, planId: result.outcomes[0]!.planId! }];
    const refused = await run(WatchInboxRetry.make({ plans }), 'WatchInboxExportResult');
    expect(refused.outcomes[0]?.failures).toEqual([{ code: 'WATCH_RECOVERY_NOT_APPLICABLE' }]);
    const original = await run(
      WatchInboxRetry.make({ plans, recovery: 'original' }),
      'WatchInboxExportResult'
    );
    expect(original.outcomes[0]).toMatchObject({ accepted: 1, failures: [] });
    expect(await history()).toMatchObject([
      {
        exportMode: 'direct',
        recovery: 'original',
        requestedExport: { mode: { _tag: 'FrameExport', timestampSeconds: 4 }, rotation: 90 },
      },
    ]);
    expect((await history())[0]).not.toHaveProperty('rotation');
    expect(JSON.stringify(harness.local.read('watch-store'))).not.toMatch(
      /https:|blob:|data:|media\.jpg/
    );
  });

  it('refuses transformed Avatars and plan writes that cannot be persisted', async () => {
    await watching('avatar');
    instagram.state.search = avatarSearch({ ...TARGET, pictureId: 'PIC_B' });
    await check();
    const [entry] = await inbox();
    const refused = await run(
      WatchInboxExport.make({
        entryIds: [entry!.entryId],
        settings: {
          mode: FrameExport.make({ timestampSeconds: 1 }),
        },
      }),
      'WatchInboxExportResult'
    );
    expect(refused.outcomes[0]?.failures).toEqual([{ code: 'WATCH_RECOVERY_NOT_APPLICABLE' }]);
    harness.local.failWrites = true;
    const failed = await exportEntries(entry!.entryId);
    expect(failed.outcomes[0]?.failures).toEqual([{ code: 'WATCH_STORE_FAILED' }]);
    expect(harness.downloads).toHaveLength(0);
  });

  it('requires explicit silent re-encode approval and preserves the requested plan in History', async () => {
    const { entryId, post } = await discoverPost({ id: '220', video: true });
    instagram.state.media.C220 = restMedia(post);
    await processingBrowser(harness, instagram);
    silentBrowser();
    const result = await run(
      WatchInboxExport.make({
        entryIds: [entryId],
        settings: { mode: SilentExport.make({ reencode: 'forbid' }) },
      }),
      'WatchInboxExportResult'
    );
    expect(result.outcomes[0]).toMatchObject({
      accepted: 0,
      skipped: [{ code: 'SILENT_REENCODE_DECLINED' }],
    });
    expect(harness.downloads).toHaveLength(0);
    const retried = await run(
      WatchInboxRetry.make({
        plans: [{ entryId, planId: result.outcomes[0]!.planId! }],
        recovery: 'reencode',
      }),
      'WatchInboxExportResult'
    );
    expect(retried.outcomes[0]).toMatchObject({ accepted: 1, failures: [] });
    expect(await history()).toMatchObject([
      {
        exportMode: 'silent',
        requestedExport: { mode: { _tag: 'SilentExport', reencode: 'forbid' } },
        recovery: 'reencode',
      },
    ]);
  });

  it('verifies the creating login again after reacquisition before browser delivery', async () => {
    const { entryId, post } = await discoverPost({ id: '300', video: false });
    instagram.state.media.C300 = restMedia(post);
    harness.setFetch((url, init) => {
      const response = instagram.handle(url, init);
      if (new URL(url).pathname.includes('/media/'))
        instagram.state.viewer = { id: '3003', username: 'instagram' };
      return response;
    });
    const result = await exportEntries(entryId);
    expect(result.outcomes[0]).toMatchObject({
      accepted: 0,
      failures: [{ code: 'IG_NOT_AUTHENTICATED' }],
    });
    expect(harness.downloads).toHaveLength(0);
    expect(await history()).toHaveLength(0);
  });

  it('rejects wrong owners, parents, and ambiguous parent matches before downloading', async () => {
    const { entryId, post } = await discoverPost({ id: '400', children: ['401', '402'] });
    const valid = restMedia(post);
    const [parent] = valid.items;
    for (const items of [
      restMedia({ ...post, owner: '3003' }).items,
      restMedia({ ...post, owner: '3003', coauthors: ['3004'] }).items,
      [{ ...parent, pk: '999' }],
      [{ ...parent, user: { pk: TARGET.id, id: '3003' } }],
      [parent, parent],
    ]) {
      instagram.state.media.C400 = { ...valid, items };
      const result = await exportEntries(entryId);
      expect(result.outcomes[0]?.failures).toEqual([{ code: 'IG_RESPONSE_SHAPE_UNKNOWN' }]);
      expect((await inbox())[0]).not.toHaveProperty('unavailable');
      expect(harness.downloads).toHaveLength(0);
    }
  });

  it('downloads a Post as Original with a History receipt and keeps the inbox entry', async () => {
    const { entryId, post } = await discoverPost({ id: '500', video: false });
    instagram.state.media[`C${post.id}`] = restMedia(post);

    const result = await exportEntries(entryId);

    expect(result).toMatchObject({
      outcomes: [{ entryId, accepted: 1, failures: [] }],
      unknownEntryIds: [],
    });
    expect(harness.downloads.map(download => download.filename)).toEqual([
      `C${post.id}_GraphImage_1.jpg`,
    ]);
    expect(await history()).toMatchObject([
      {
        mediaId: post.id,
        exportMode: 'direct',
        outcome: 'accepted',
        origin: { kind: 'source', sourceKind: 'post' },
      },
    ]);
    expect(await inbox()).toHaveLength(1);
  });

  it('downloads a collab Post another account owns with the target as a co-author', async () => {
    const { entryId, post } = await discoverPost({
      id: '510',
      video: false,
      owner: '3003',
      coauthors: ['3003', TARGET.id],
    });
    instagram.state.media[`C${post.id}`] = restMedia(post);

    expect((await exportEntries(entryId)).outcomes[0]).toMatchObject({ accepted: 1, failures: [] });
  });

  it('exports only the frozen Sidecar children and records the missing one', async () => {
    const { entryId, post } = await discoverPost({ id: '600', children: ['601', '602'] });
    instagram.state.media[`C${post.id}`] = restMedia({ ...post, children: ['601', '603'] });

    const first = await exportEntries(entryId);

    expect(first.outcomes).toEqual([
      expect.objectContaining({
        accepted: 1,
        failures: [{ child: 1, code: 'WATCH_MEDIA_UNAVAILABLE' }],
      }),
    ]);
    expect(harness.downloads.map(download => download.url)).toHaveLength(1);
    expect((await inbox())[0]).toMatchObject({ childCount: 2, missingChildren: 1 });

    instagram.state.media[`C${post.id}`] = restMedia(post);
    const second = await exportEntries(entryId);

    expect(second.outcomes[0]).toMatchObject({
      accepted: 1,
      failures: [{ child: 1, code: 'WATCH_MEDIA_UNAVAILABLE' }],
    });
  });

  it('keeps an unsupported recorded Sidecar child retryable rather than marking it absent', async () => {
    const { entryId, post } = await discoverPost({ id: '610', children: ['611', '612'] });
    const valid = restMedia(post);
    const parents = valid.items.map(item => ({
      ...item,
      carousel_media:
        'carousel_media' in item && Array.isArray(item.carousel_media) ? item.carousel_media : [],
    }));
    instagram.state.media.C610 = {
      ...valid,
      items: parents.map(parent => ({
        ...parent,
        carousel_media: parent.carousel_media.map(child => ({
          ...child,
          media_type: child.pk === '612' ? 99 : child.media_type,
        })),
      })),
    };
    const failed = await exportEntries(entryId);
    expect(failed.outcomes[0]?.failures).toEqual([{ code: 'IG_RESPONSE_SHAPE_UNKNOWN' }]);
    expect((await inbox())[0]).not.toHaveProperty('unavailable');
    expect((await inbox())[0]).not.toHaveProperty('missingChildren');
    expect(harness.downloads).toHaveLength(0);

    instagram.state.media.C610 = {
      ...valid,
      items: parents.map(parent => ({
        ...parent,
        carousel_media: [...parent.carousel_media, { pk: '613', media_type: 99 }],
      })),
    };
    expect((await exportEntries(entryId)).outcomes[0]).toMatchObject({ accepted: 2, failures: [] });
    expect(harness.downloads).toHaveLength(2);
  });

  it('fails an expired Story without a request and keeps it unavailable', async () => {
    const cutoff = await watching('stories');
    instagram.state.stories[TARGET.id] = storyResponse(TARGET.id, [
      { id: '71', takenAt: cutoff + 60, expiresAt: cutoff + 3600 },
    ]);
    await check();
    const [entry] = await inbox();
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);
    const fetches = vi.mocked(globalThis.fetch).mock.calls.length;

    const result = await exportEntries(entry!.entryId);

    expect(result.outcomes[0]).toMatchObject({
      accepted: 0,
      failures: [{ code: 'WATCH_STORY_EXPIRED' }],
    });
    // Only the viewer check ran; the Story itself was never requested.
    expect(vi.mocked(globalThis.fetch).mock.calls.length - fetches).toBe(1);
    expect((await inbox())[0]?.unavailable).toBe('WATCH_STORY_EXPIRED');
    expect(harness.downloads).toEqual([]);
  });

  it('establishes Instant absence only from a valid feed', async () => {
    const cutoff = await watching('instants');
    const instant = { pk: '81', owner: TARGET.id, takenAt: cutoff + 60 };
    instagram.state.instants = instantsFeed([instant]);
    await check();
    const [entry] = await inbox();

    instagram.state.instants = { data: {} };
    const malformed = await exportEntries(entry!.entryId);
    instagram.state.instants = instantsFeed([]);
    const absent = await exportEntries(entry!.entryId);

    expect(malformed.outcomes[0]?.failures).toEqual([{ code: 'IG_RESPONSE_SHAPE_UNKNOWN' }]);
    expect(absent.outcomes[0]?.failures).toEqual([{ code: 'WATCH_INSTANT_NOT_IN_FEED' }]);
    expect((await inbox())[0]?.unavailable).toBe('WATCH_INSTANT_NOT_IN_FEED');
  });

  it('downloads an Avatar change only while it is the current picture', async () => {
    await watching('avatar');
    instagram.state.search = avatarSearch({ ...TARGET, pictureId: 'PIC_B' });
    await check();
    const [entry] = await inbox();

    const current = await exportEntries(entry!.entryId);
    instagram.state.search = avatarSearch({ ...TARGET, pictureId: 'PIC_C' });
    const changed = await exportEntries(entry!.entryId);

    expect(current.outcomes[0]).toMatchObject({ accepted: 1, failures: [] });
    expect(changed.outcomes[0]?.failures).toEqual([{ code: 'WATCH_AVATAR_CHANGED' }]);
    expect(harness.downloads).toHaveLength(1);
  });

  it('never substitutes an ambiguous or retyped match and continues with other entries', async () => {
    const { entryId, post } = await discoverPost({ id: '900', children: ['901', '902'] });
    instagram.state.media[`C${post.id}`] = restMedia({ ...post, children: ['901', '901'] });

    const ambiguous = await exportEntries('unknown-entry', entryId);
    instagram.state.media[`C${post.id}`] = restMedia({ ...post, children: ['902', '901'] });
    const retyped = await exportEntries(entryId);

    expect(ambiguous).toMatchObject({
      outcomes: [{ entryId, accepted: 0, failures: [{ code: 'IG_RESPONSE_SHAPE_UNKNOWN' }] }],
      unknownEntryIds: ['unknown-entry'],
    });
    expect(retyped.outcomes[0]?.failures).toEqual([{ code: 'IG_RESPONSE_SHAPE_UNKNOWN' }]);
    expect((await inbox())[0]).not.toHaveProperty('missingChildren');
    expect(harness.downloads).toEqual([]);
  });
});
