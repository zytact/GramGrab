import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Schema } from 'effect';
import {
  AccountIdSelector,
  DirectExport,
  FrameExport,
  SilentExport,
  WatchAdd,
  WatchCheck,
  WatchNeeds,
  WatchNeedsResult,
  WatchAttentionRecover,
  WatchAttentionRecoverResult,
  WatchInboxList,
  WatchInboxListResult,
  WatchInboxRemove,
  WatchInboxExport,
  WatchInboxRetry,
  WatchInboxExportResult,
  WatchList,
  type WatchCommand,
  type WatchAction,
} from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import { createWatchInstagram, TARGET, postsPage, restMedia } from '../test/watch-instagram.ts';
import { processingBrowser, silentBrowser } from '../test/processing-browser.ts';

const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;
let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;

beforeEach(async () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 1, 12) });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(async (_algorithm, input) => {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
  });
  harness = createExtensionHarness();
  instagram = createWatchInstagram();
  instagram.state.accounts.instagram = { id: TARGET.id };
  instagram.state.profile = {
    data: { user: { id: TARGET.id, pk: TARGET.id, username: 'instagram' } },
  };
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

async function settled<T>(promise: Promise<T>): Promise<T> {
  let answer: { value: T } | undefined;
  void promise.then(value => {
    answer = { value };
  });
  for (let second = 0; second < 1200; second++) {
    if (answer) return answer.value;
    await vi.advanceTimersByTimeAsync(1000);
  }
  throw new Error('Native command did not settle.');
}

async function result(command: WatchCommand) {
  const terminal = await settled(harness.command(command));
  if (terminal._tag !== 'Completed') throw new Error(JSON.stringify(terminal));
  return terminal.result;
}
const needs = async () =>
  Schema.decodeUnknownSync(WatchNeedsResult)(await result(WatchNeeds.make()));
const inbox = async () =>
  Schema.decodeUnknownSync(WatchInboxListResult)(await result(WatchInboxList.make()));
const recover = async (
  operation: 'retry' | 'dismiss' | 'confirm',
  attentionIds: readonly string[]
) =>
  Schema.decodeUnknownSync(WatchAttentionRecoverResult)(
    await result(WatchAttentionRecover.make({ operation, attentionIds }))
  );
const check = async () => {
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  return result(WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: TARGET.id })] }));
};
async function discover(actions: readonly WatchAction[] = ['collect']) {
  await result(
    WatchAdd.make({ target: 'instagram', kinds: ['posts'], actions, acceptUnattended: true })
  );
  await check();
  const post = { id: '500', takenAt: Math.floor(Date.now() / 1000) + 60, children: ['501', '502'] };
  instagram.state.posts = { '': postsPage([post]) };
  instagram.state.media.C500 = restMedia(post);
  return check;
}

describe('native Watch attention and inbox', () => {
  it('recovers the exact failed child, reports failed notification retry, and keeps page counts equal', async () => {
    const find = await discover(['download', 'notify', 'collect']);
    const { browser } = await import('../lib/browser.ts');
    const download = vi.mocked(browser.downloads.download);
    download
      .mockImplementationOnce(download.getMockImplementation()!)
      .mockRejectedValueOnce(new Error('network failure'));
    await find();
    instagram.state.posts = { '': { data: {} } };
    await check();
    const before = await needs();
    expect(before.items).toHaveLength(3);
    expect(await result(WatchList.make())).toMatchObject({
      attentionCount: 3,
      watches: [{ attentionCount: 3, inboxCount: 1 }],
    });
    const notify = before.items.find(
      item => item._tag === 'ActionAttention' && item.action === 'notify'
    )!;
    const failedChild = before.items.find(
      item => item._tag === 'ActionAttention' && item.action === 'download'
    )!;
    const problem = before.items.find(item => item._tag === 'CheckAttention')!;
    const outcome = await recover('retry', [
      failedChild.attentionId,
      notify.attentionId,
      problem.attentionId,
      'missing',
    ]);
    expect(outcome).toMatchObject({
      recoveredAttentionIds: [failedChild.attentionId],
      unknownAttentionIds: ['missing'],
      refused: [{ attentionId: problem.attentionId, code: 'WATCH_RECOVERY_NOT_APPLICABLE' }],
      failures: [
        {
          attentionId: notify.attentionId,
          outcome: { state: 'failed', code: 'WATCH_NOTIFY_PERMISSION_DENIED' },
        },
      ],
    });
    expect(harness.downloads).toHaveLength(2);
    expect(harness.local.read('download-history')).toMatchObject({
      entries: [{ outcome: 'accepted' }, { outcome: 'accepted' }],
    });
    const after = await needs();
    expect(after.items.map(item => item.attentionId)).toEqual([
      problem.attentionId,
      notify.attentionId,
    ]);
    expect(await result(WatchList.make())).toMatchObject({ attentionCount: 2 });
    expect(await recover('confirm', [notify.attentionId, problem.attentionId])).toMatchObject({
      refused: [{ attentionId: notify.attentionId }, { attentionId: problem.attentionId }],
    });
    await recover('dismiss', [notify.attentionId]);
    expect((await needs()).items).toHaveLength(1);
    expect(harness.downloads).toHaveLength(2);
  });

  it('isolates other-login IDs and exposes only stored count when authentication fails', async () => {
    const find = await discover(['collect', 'notify']);
    await find();
    const attentionId = (await needs()).items[0]!.attentionId;
    const entryId = (await inbox()).entries[0]!.entryId;
    instagram.state.viewer = { id: '3003', username: 'instagram' };
    expect(await needs()).toMatchObject({ items: [], watches: [], entries: [] });
    expect(await recover('dismiss', [attentionId])).toMatchObject({
      unknownAttentionIds: [attentionId],
    });
    expect(await result(WatchInboxRemove.make({ entryIds: [entryId] }))).toMatchObject({
      removedEntryIds: [],
      unknownEntryIds: [entryId],
    });
    expect(await result(WatchInboxExport.make({ entryIds: [entryId] }))).toMatchObject({
      outcomes: [],
      unknownEntryIds: [entryId],
    });
    const absent = await settled(
      harness.command(
        WatchInboxList.make({ watch: AccountIdSelector.make({ accountId: TARGET.id }) })
      )
    );
    expect(absent).toMatchObject({
      _tag: 'Rejected',
      failure: { failure: { code: 'WATCH_NOT_FOUND' } },
    });
    instagram.state.viewer = null;
    const unverified = await settled(harness.command(WatchNeeds.make()));
    expect(unverified).toMatchObject({
      _tag: 'Rejected',
      failure: {
        failure: { code: 'IG_NOT_AUTHENTICATED' },
        detail: { _tag: 'StoredWatchCount', count: 1 },
      },
    });
    expect(JSON.stringify(unverified)).not.toContain(entryId);
    expect(harness.downloads).toHaveLength(0);
  });

  it('runs all modes through the native dispatcher, freezes retry, and removes inbox metadata only', async () => {
    const find = await discover();
    await find();
    const entry = (await inbox()).entries[0]!;
    expect(entry.remainingRetentionMs).toBeGreaterThan(0);
    const { seek } = await processingBrowser(harness, instagram);
    const { browser } = await import('../lib/browser.ts');
    const download = vi.mocked(browser.downloads.download);
    download
      .mockImplementationOnce(download.getMockImplementation()!)
      .mockRejectedValueOnce(new Error('network failure'));
    const initial = Schema.decodeUnknownSync(WatchInboxExportResult)(
      await result(
        WatchInboxExport.make({
          entryIds: [entry.entryId, 'missing'],
          settings: { mode: FrameExport.make({ timestampSeconds: 8.5 }), rotation: 90 },
        })
      )
    );
    expect(initial).toMatchObject({
      unknownEntryIds: ['missing'],
      outcomes: [
        { accepted: 1, failures: [{ child: 1, code: 'BROWSER_DOWNLOAD_NETWORK_FAILED' }] },
      ],
    });
    const retry = await result(
      WatchInboxRetry.make({
        plans: [{ entryId: entry.entryId, planId: initial.outcomes[0]!.planId! }],
      })
    );
    expect(retry).toMatchObject({ outcomes: [{ accepted: 2, failures: [] }] });
    expect(harness.downloads).toHaveLength(2);
    expect(seek).toHaveBeenCalledWith(8.5);
    await result(
      WatchInboxExport.make({ entryIds: [entry.entryId], settings: { mode: DirectExport.make() } })
    );
    silentBrowser();
    expect(
      await result(
        WatchInboxExport.make({
          entryIds: [entry.entryId],
          settings: { mode: SilentExport.make({ reencode: 'require' }) },
        })
      )
    ).toMatchObject({ outcomes: [{ accepted: 2, failures: [] }] });
    expect(harness.downloads).toHaveLength(6);
    expect((await inbox()).entries).toHaveLength(1);
    const history = harness.local.read('download-history');
    expect(
      await result(WatchInboxRemove.make({ entryIds: [entry.entryId, 'missing'] }))
    ).toMatchObject({ removedEntryIds: [entry.entryId], unknownEntryIds: ['missing'] });
    expect((await inbox()).entries).toEqual([]);
    expect(await result(WatchList.make())).toMatchObject({ watches: [{ inboxCount: 0 }] });
    expect(harness.local.read('download-history')).toEqual(history);
    expect(harness.downloads).toHaveLength(6);
    expect(harness.browser.tabs.create).not.toHaveBeenCalled();
    expect(harness.local.read('workspace-snapshot')).toBeUndefined();
  });

  it('confirms an uncertain child without replaying delivery or adding History', async () => {
    const find = await discover(['download']);
    const { browser } = await import('../lib/browser.ts');
    const download = vi.mocked(browser.downloads.download);
    const original = download.getMockImplementation()!;
    download.mockImplementationOnce(async options => {
      const id = await original(options);
      harness.local.failWrites = true;
      return id;
    });
    await find();
    harness.downloads.splice(0);
    harness.local.failWrites = false;
    await harness.loadWorker();
    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const uncertain = (await needs()).items.find(
      item => item._tag === 'ActionAttention' && item.state === 'unconfirmed'
    )!;
    const history = harness.local.read('download-history');
    const delivered = harness.downloads.length;
    expect(await recover('retry', [uncertain.attentionId])).toMatchObject({
      refused: [{ attentionId: uncertain.attentionId }],
    });
    expect(await recover('confirm', [uncertain.attentionId])).toMatchObject({
      recoveredAttentionIds: [uncertain.attentionId],
      failures: [],
    });
    expect(harness.downloads).toHaveLength(delivered);
    expect(harness.local.read('download-history')).toEqual(history);
    expect((await needs()).items).toEqual([]);
  });
});
