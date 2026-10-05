import { createHash, webcrypto } from 'node:crypto';
import { Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  WatchAdd,
  WatchCheck,
  WatchInboxList,
  WatchList,
  WatchLifecycle,
  WatchRecover,
  type WatchAction,
  type WatchCommand,
} from '@gramgrab/protocol';
import type { WatchCommandResponse } from '../messaging/contracts.ts';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, createWatchInstagram, postsPage, restMedia } from '../test/watch-instagram.ts';
import { WatchStore } from './contracts.ts';

const START = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;
let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
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
  harness.setFetch(instagram.handle);
  harness.grantedPermissions.add('notifications');
  await harness.loadWorker();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

async function until(done: () => boolean) {
  for (let turn = 0; turn < 600; turn++) {
    if (done()) return;
    await vi.advanceTimersByTimeAsync(1000);
  }
  throw new Error('Worker did not settle within ten minutes.');
}

async function run(command: WatchCommand) {
  let answer: WatchCommandResponse | undefined;
  void harness.send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command }).then(response => {
    answer = response;
  });
  await until(() => answer !== undefined);
  if (!answer?.result) throw new Error(JSON.stringify(answer?.failure));
  return answer.result;
}

const store = () =>
  Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'), {
    onExcessProperty: 'error',
  });
const discovery = () => store().watches[0]!.discoveries[0]!;
const children = () => discovery().download!.children;
const check = async () => {
  await vi.advanceTimersByTimeAsync(5 * MINUTE);
  return run(WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: TARGET.id })] }));
};

async function discover(actions: readonly WatchAction[] = ['download', 'collect', 'notify']) {
  await run(
    WatchAdd.make({ target: TARGET.username, kinds: ['posts'], actions, acceptUnattended: true })
  );
  await check();
  expect(harness.downloads).toHaveLength(0);
  const post = { id: '500', takenAt: Math.floor(Date.now() / 1000) + 60, children: ['501', '502'] };
  instagram.state.posts = { '': postsPage([post]) };
  instagram.state.media.C500 = restMedia(post);
  return check;
}

const recover = (
  operation: 'retry' | 'dismiss' | 'confirm' | 'download-again',
  action: 'download' | 'collect' | 'notify' = 'download',
  child?: number
) =>
  run(
    WatchRecover.make({
      action,
      operation,
      entryIds: [discovery().id],
      ...(child === undefined ? {} : { child }),
    })
  );

async function resume() {
  await harness.loadWorker();
  harness.fireAlarm('watch-pump');
  await until(() =>
    children().every(child => child.status !== 'starting' && child.status !== 'pending')
  );
}

async function interrupted(keepBrowserRecord: boolean) {
  const find = await discover(['download']);
  const { browser } = await import('../lib/browser.ts');
  const original = vi.mocked(browser.downloads.download).getMockImplementation()!;
  const download = vi.spyOn(browser.downloads, 'download').mockImplementation(async options => {
    const id = await original(options);
    harness.local.failWrites = true;
    return id;
  });
  await find();
  expect(children()[0]?.status).toBe('starting');
  expect(harness.downloads).toHaveLength(1);
  if (!keepBrowserRecord) harness.downloads.splice(0);
  harness.local.failWrites = false;
  download.mockRestore();
  await resume();
}

describe('Watch auto-download and recovery', () => {
  it('announces a delayed action failure once, including after worker reload', async () => {
    const find = await discover();
    for (let index = 0; index < 3; index++)
      await harness.browser.downloads.download({ url: 'https://cdn.invalid/person.mp4' });
    await find();
    expect(children().map(child => child.status)).toEqual(['pending', 'pending']);
    expect(harness.notifications.size).toBe(1);
    for (const download of harness.downloads) download.state = 'complete';
    harness.failDownloads(new Error('network failed'));
    await resume();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(children().every(child => child.status === 'failed')).toBe(true);
    expect(harness.notifications.size).toBe(2);
    expect([...harness.notifications.values()].at(-1)?.message).toContain('Download:');

    await harness.loadWorker();
    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(harness.notifications.size).toBe(2);
  });

  it('persists independent actions, accepts each child once, and records History at acceptance', async () => {
    const find = await discover();
    await find();
    expect(children().map(child => child.status)).toEqual(['accepted', 'accepted']);
    expect(harness.downloads.map(download => download.state)).toEqual([
      'in_progress',
      'in_progress',
    ]);
    expect(harness.notifications.size).toBe(1);
    const inbox = await run(WatchInboxList.make());
    expect(inbox._tag === 'WatchInboxListResult' && inbox.entries.length).toBe(1);
    expect(harness.local.read('download-history')).toMatchObject({
      entries: [{ outcome: 'accepted' }, { outcome: 'accepted' }],
    });
    await check();
    expect(harness.downloads).toHaveLength(2);
    expect(harness.notifications.size).toBe(1);
    expect(JSON.stringify(store())).not.toMatch(
      /https:|cdn\.invalid|filenameHint|caption|csrf-token/
    );
  });

  it('retries only a failed child while preserving accepted children, notification, and collection', async () => {
    const find = await discover();
    const { browser } = await import('../lib/browser.ts');
    const original = vi.mocked(browser.downloads.download).getMockImplementation()!;
    const download = vi.spyOn(browser.downloads, 'download');
    download.mockImplementation(async options => {
      if (options.filename?.endsWith('_2.mp4')) throw new Error('network failed');
      return original(options);
    });
    await find();
    expect(children().map(child => child.status)).toEqual(['accepted', 'failed']);
    download.mockRestore();
    await recover('retry');
    expect(children().map(child => child.status)).toEqual(['accepted', 'accepted']);
    expect(harness.downloads).toHaveLength(2);
    expect(harness.notifications.size).toBe(1);
    expect(discovery().collect).toHaveProperty('at');
    const result = await recover('confirm');
    expect(result).toMatchObject({ refused: [{ code: 'WATCH_RECOVERY_NOT_APPLICABLE' }] });
  });

  it('does not start dependent downloads when the attempt record cannot be saved', async () => {
    const find = await discover(['download']);
    const set = harness.local.set.getMockImplementation()!;
    harness.local.set.mockImplementation(async items => {
      const next = items['watch-store'];
      if (next && JSON.stringify(next).includes('"starting"')) throw new Error('write rejected');
      return set(items);
    });
    await find();
    expect(harness.downloads).toHaveLength(0);
    expect(children().every(child => child.status === 'pending')).toBe(true);
    harness.local.set.mockImplementation(set);
    await resume();
    expect(harness.downloads).toHaveLength(2);
  });

  it('reconciles acceptance after its outcome write failed and repairs the receipt without redownloading', async () => {
    await interrupted(true);
    expect(children().map(child => child.status)).toEqual(['accepted', 'accepted']);
    expect(harness.downloads).toHaveLength(2);
    await check();
    expect(harness.downloads).toHaveLength(2);
    expect(harness.local.read('download-history')).toMatchObject({
      entries: [{ outcome: 'accepted' }, { outcome: 'accepted' }],
    });
  });

  it('marks an unreconciled attempt uncertain and only downloads again after an explicit choice', async () => {
    await interrupted(false);
    expect(children()[0]?.status).toBe('uncertain');
    expect(harness.downloads).toHaveLength(1);
    await check();
    expect(harness.downloads).toHaveLength(1);
    expect(await recover('retry')).toMatchObject({
      refused: [{ code: 'WATCH_RECOVERY_NOT_APPLICABLE' }],
    });
    await recover('download-again', 'download', 0);
    expect(children().map(child => child.status)).toEqual(['accepted', 'accepted']);
    expect(harness.downloads).toHaveLength(2);
  });

  it('confirms an uncertain file without claiming browser acceptance or adding a receipt', async () => {
    await interrupted(false);
    const before = harness.local.read('download-history');
    await recover('confirm', 'download', 0);
    expect(children()[0]?.status).toBe('confirmed');
    expect(harness.downloads).toHaveLength(1);
    expect(harness.local.read('download-history')).toEqual(before);
    expect(await run(WatchList.make())).toMatchObject({ attentionCount: 0 });
  });

  it('recovers failed collection without repeating successful download or notification work', async () => {
    const find = await discover();
    const set = harness.local.set.getMockImplementation()!;
    let rejected = false;
    harness.local.set.mockImplementation(async items => {
      const value = items['watch-store'];
      if (!rejected && value && JSON.stringify(value).includes('"collect":{"at":')) {
        rejected = true;
        throw new Error('write rejected');
      }
      return set(items);
    });
    await find();
    expect(discovery().collect).toMatchObject({ status: 'failed', code: 'WATCH_STORE_FAILED' });
    expect(children().map(child => child.status)).toEqual(['accepted', 'accepted']);
    await recover('retry', 'collect');
    expect(discovery().collect).toHaveProperty('at');
    expect(harness.downloads).toHaveLength(2);
    expect(harness.notifications.size).toBe(1);
    const list = await run(WatchList.make());
    expect(list).toMatchObject({ attentionCount: 0 });
  });
  it('yields while browser download slots are occupied and resumes the persisted pending children', async () => {
    const find = await discover(['download']);
    const { browser } = await import('../lib/browser.ts');
    for (let index = 0; index < 3; index++)
      await browser.downloads.download({
        url: 'https://cdn.invalid/person.mp4',
        filename: `person-${index}.mp4`,
      });
    await find();
    expect(children().map(child => child.status)).toEqual(['pending', 'pending']);
    expect(harness.downloads).toHaveLength(3);
    for (const download of harness.downloads) download.state = 'complete';
    await resume();
    expect(children().map(child => child.status)).toEqual(['accepted', 'accepted']);
    expect(harness.downloads).toHaveLength(5);
  });

  it('keeps accepted files and History when the Watch is deleted before its outcome can be saved', async () => {
    const find = await discover();
    const { browser } = await import('../lib/browser.ts');
    const original = vi.mocked(browser.downloads.download).getMockImplementation()!;
    vi.spyOn(browser.downloads, 'download').mockImplementation(async options => {
      const id = await original(options);
      await harness.send({
        type: 'WATCH_COMMAND',
        command: WatchLifecycle.make({
          operation: 'delete',
          watches: [AccountIdSelector.make({ accountId: TARGET.id })],
        }),
      });
      return id;
    });
    await find();
    expect(store().watches).toEqual([]);
    expect(harness.downloads).toHaveLength(1);
    expect(harness.notifications.size).toBe(0);
    expect(harness.local.read('download-history')).toMatchObject({
      entries: [{ outcome: 'accepted' }],
    });
  });

  it('rechecks the creating login before delivery after media reacquisition', async () => {
    const find = await discover(['download']);
    harness.setFetch((url, init) => {
      const answer = instagram.handle(url, init);
      if (new URL(url).pathname.includes('/media/'))
        instagram.state.viewer = { id: '3030', username: 'instagram' };
      return answer;
    });
    await find();
    expect(harness.downloads).toHaveLength(0);
    expect(children().map(child => child.status)).toEqual(['pending', 'pending']);
    expect(await run(WatchList.make())).toMatchObject({ watches: [], otherLoginWatchCount: 1 });
  });

  it('only dismisses final missing children and keeps successful sibling work', async () => {
    const find = await discover(['download']);
    instagram.state.media.C500 = restMedia({
      id: '500',
      takenAt: Math.floor(Date.now() / 1000) + 60,
      children: ['503', '502'],
    });
    await find();
    expect(children().map(child => child.status)).toEqual(['failed', 'accepted']);
    expect(await recover('retry', 'download', 0)).toMatchObject({
      refused: [{ code: 'WATCH_RECOVERY_NOT_APPLICABLE' }],
    });
    await recover('dismiss', 'download', 0);
    expect(harness.downloads).toHaveLength(1);
    expect(await run(WatchList.make())).toMatchObject({ attentionCount: 0 });
  });
});
