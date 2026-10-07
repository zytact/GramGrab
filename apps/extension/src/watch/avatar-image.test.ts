import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  WatchAdd,
  WatchCheck,
  WatchLifecycle,
  WatchList,
  type WatchCommand,
  type WatchKind,
  type WatchResult,
} from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import {
  STUB_AVATAR,
  TARGET,
  VIEWER,
  avatarSearch,
  createWatchInstagram,
  stubAvatarScaling,
} from '../test/watch-instagram.ts';
import type { WatchAvatarsResponse, WatchCommandResponse } from '../messaging/contracts.ts';

const START = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  stubAvatarScaling();
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

async function run<T extends WatchResult['_tag']>(command: WatchCommand, expected: T) {
  let response: WatchCommandResponse | undefined;
  void harness
    .send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command })
    .then(answer => (response = answer));
  while (!response) await vi.advanceTimersByTimeAsync(1_000);
  if (response.result?._tag !== expected) throw new Error(JSON.stringify(response));
  return response.result as Extract<WatchResult, { _tag: T }>;
}

const selector = AccountIdSelector.make({ accountId: TARGET.id });

const addWatch = (kind: WatchKind) =>
  run(
    WatchAdd.make({
      target: TARGET.username,
      kinds: [kind],
      actions: ['collect'],
      acceptUnattended: true,
    }),
    'WatchAddResult'
  );

async function checkLater(after = 5 * MINUTE) {
  await vi.advanceTimersByTimeAsync(after);
  await run(WatchCheck.make({ watches: [selector] }), 'WatchCheckResult');
}

const avatarImage = () =>
  (
    harness.local.read('watch-store') as {
      watches: { avatarImage?: { pictureId: string; checkedAt: number } }[];
    }
  ).watches[0]?.avatarImage;

/** Picture loads from the CDN so far. */
const pictureLoads = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(
      ([input]) =>
        new URL(input instanceof Request ? input.url : input).hostname === 'sanitized.invalid'
    ).length;

const avatars = (viewerId: string) =>
  harness.send<WatchAvatarsResponse>({ type: 'WATCH_AVATARS', viewerId });

describe('Watch Avatar images', () => {
  it('loads the picture of a Watch of Avatar changes only when its identity changes', async () => {
    await addWatch('avatar');
    await checkLater();
    expect(avatarImage()?.pictureId).toBe('PIC_A');
    await checkLater();
    expect(pictureLoads()).toBe(1);

    instagram.state.search = avatarSearch({ ...TARGET, pictureId: 'PIC_B' });
    await checkLater();
    expect(avatarImage()?.pictureId).toBe('PIC_B');
    expect(pictureLoads()).toBe(2);
    expect(instagram.state.searches).toHaveLength(3);
  });

  it('looks up the picture of any other Watch once, then again only a week later', async () => {
    await addWatch('stories');
    await checkLater();
    expect(avatarImage()?.pictureId).toBe('PIC_A');
    await checkLater();
    expect(instagram.state.searches).toHaveLength(1);

    await checkLater(7 * DAY);
    expect(instagram.state.searches).toHaveLength(2);
    expect(pictureLoads()).toBe(1);
    expect(avatarImage()?.checkedAt).toBeGreaterThan(START + 7 * DAY);
  });

  it('keeps the placeholder when the picture will not load, and tries again next check', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('undecodable');
    });
    await addWatch('avatar');
    await checkLater();
    expect(avatarImage()).toBeUndefined();

    stubAvatarScaling();
    await checkLater();
    expect(avatarImage()?.pictureId).toBe('PIC_A');
  });

  it('shows the page only the asking login’s pictures, and its own picture from memory', async () => {
    instagram.state.viewer = { ...VIEWER, profile_pic_url: 'https://sanitized.invalid/viewer' };
    const { watch } = await addWatch('avatar');
    await checkLater();
    await run(WatchList.make(), 'WatchListResult');

    expect(await avatars(VIEWER.id)).toEqual({
      login: STUB_AVATAR,
      watches: { [watch.watchId]: STUB_AVATAR },
    });
    expect(await avatars('1009')).toEqual({ watches: {} });
    expect(harness.local.read('watch-store')).not.toHaveProperty('viewer');

    await run(
      WatchLifecycle.make({ operation: 'delete', watches: [selector] }),
      'WatchLifecycleResult'
    );
    expect(await avatars(VIEWER.id)).toEqual({ login: STUB_AVATAR, watches: {} });
  });
});
