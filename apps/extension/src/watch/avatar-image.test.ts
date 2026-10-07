import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  KindBaselineRecorded,
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
import { Schema } from 'effect';
import { AvatarJpeg, STORE_BUDGET_BYTES, WatchStore } from './contracts.ts';

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
  Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches[0]?.avatarImage;

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
    expect(
      Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches[0]
        ?.avatarLookupAt
    ).toBeGreaterThan(START + 7 * DAY);
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

  it('spaces failed cosmetic lookups a week apart instead of repeating them every check', async () => {
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('undecodable');
    });
    await addWatch('stories');
    await checkLater();
    expect(avatarImage()).toBeUndefined();
    await checkLater();
    expect(instagram.state.searches).toHaveLength(1);

    stubAvatarScaling();
    await checkLater(7 * DAY);
    expect(instagram.state.searches).toHaveLength(2);
    expect(avatarImage()?.pictureId).toBe('PIC_A');
  });

  it('accepts exactly 8 KiB of image bytes and rejects larger or malformed base64', () => {
    const accepts = Schema.is(AvatarJpeg);
    expect(accepts(btoa('x'.repeat(8192)))).toBe(true);
    expect(accepts(btoa('x'.repeat(8193)))).toBe(false);
    expect(accepts('abc')).toBe(false);
    expect(accepts('')).toBe(false);
  });

  it('looks up an initial image when a partial check omitted the Avatar kind', async () => {
    const { watch } = await addWatch('avatar');
    const { refreshAvatarImage } = await import('./avatar-image.ts');
    let done = false;
    void refreshAvatarImage(watch.watchId, VIEWER.id, {
      kinds: [KindBaselineRecorded.make({ kind: 'posts' })],
      avatarAttempted: false,
    }).then(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(1_000);
    expect(avatarImage()?.pictureId).toBe('PIC_A');
    expect(instagram.state.searches).toHaveLength(1);
  });

  it.each([true, false])(
    'distinguishes a failed profile check from an attempted Avatar search, profile fails=%s',
    async profileFails => {
      await run(
        WatchAdd.make({
          target: TARGET.username,
          kinds: ['stories', 'avatar'],
          actions: ['collect'],
          acceptUnattended: true,
        }),
        'WatchAddResult'
      );
      if (profileFails)
        instagram.state.profile = { data: { user: { id: '9999', username: TARGET.username } } };
      else instagram.state.search = {};
      await checkLater();
      expect(instagram.state.searches).toHaveLength(1);
      expect(!!avatarImage()).toBe(profileFails);
    }
  );

  it('does not count a deferred cosmetic lookup as a refresh attempt', async () => {
    const { watch } = await addWatch('stories');
    const { requestLedger } = await import('../instagram/requests.ts');
    for (let index = 0; index < 60; index++) {
      requestLedger.begin({ kind: 'person' }, Date.now());
      requestLedger.end({ kind: 'person' }, Date.now(), 200);
    }
    const { refreshAvatarImage } = await import('./avatar-image.ts');
    await refreshAvatarImage(watch.watchId, VIEWER.id, {
      kinds: [KindBaselineRecorded.make({ kind: 'stories' })],
      avatarAttempted: false,
    });
    expect(instagram.state.searches).toHaveLength(0);
    expect(
      Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches[0]
        ?.avatarLookupAt
    ).toBeUndefined();
  });

  it.each([true, false])(
    'does not fetch an initial image after a later login check fails, signed out=%s',
    async signedOut => {
      await run(
        WatchAdd.make({
          target: TARGET.username,
          kinds: ['stories', 'avatar'],
          actions: ['collect'],
          acceptUnattended: true,
        }),
        'WatchAddResult'
      );
      harness.setFetch((url, init) => {
        const response = instagram.handle(url, init);
        if (new URL(url).searchParams.get('query_hash') === '45246d3fe16ccc6577e0bd297a5db1ab')
          instagram.state.viewer = signedOut ? null : { id: '1009', username: 'instagram' };
        return response;
      });
      await checkLater();
      expect(instagram.state.searches).toHaveLength(0);
      expect(avatarImage()).toBeUndefined();
      expect(
        Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches[0]
          ?.avatarLookupAt
      ).toBeUndefined();
    }
  );

  it('restores the memory-only login image from a background viewer query after restart', async () => {
    instagram.state.viewer = { ...VIEWER, profile_pic_url: 'https://sanitized.invalid/viewer' };
    await addWatch('avatar');
    expect((await avatars(VIEWER.id)).login).toBe(STUB_AVATAR);
    await harness.loadWorker();
    expect((await avatars(VIEWER.id)).login).toBeUndefined();
    const { fetchViewer } = await import('./identity.ts');
    const { PersonRequests } = await import('../instagram/requests.ts');
    const { Effect } = await import('effect');
    await Effect.runPromise(fetchViewer.pipe(Effect.provide(PersonRequests)));
    expect((await avatars(VIEWER.id)).login).toBe(STUB_AVATAR);
    expect(harness.local.read('watch-store')).not.toHaveProperty('viewer');
  });

  it.each([
    { observed: true, room: 64 },
    { observed: false, room: 64 },
    { observed: false, room: 0 },
  ])('bounds optional cache requests and writes at capacity, %j', async ({ observed, room }) => {
    const { watch } = await addWatch('avatar');
    const store = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
    const first = store.watches[0]!;
    const image = { pictureId: 'PIC_A', jpeg: btoa('x'.repeat(8192)), checkedAt: START };
    const template = { ...first, avatarImage: image };
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const count = Math.floor((STORE_BUDGET_BYTES - size(store)) / (size(template) + 1));
    const filled = {
      ...store,
      watches: [
        first,
        ...Array.from({ length: count }, () => ({ ...template, id: crypto.randomUUID() })),
      ],
    };
    const last = { ...template, id: crypto.randomUUID(), avatarImage: { ...image, jpeg: 'AAAA' } };
    const extra = Math.floor((STORE_BUDGET_BYTES - size(filled) - size(last) - 1 - room) / 4) * 4;
    if (extra >= 0) {
      last.avatarImage.jpeg += 'AAAA'.repeat(extra / 4);
      filled.watches.push(last);
    }
    expect(STORE_BUDGET_BYTES - size(filled)).toBeLessThan(8192);
    harness.local.write('watch-store', filled);
    const { refreshAvatarImage } = await import('./avatar-image.ts');
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage() {} };
        }
        async convertToBlob() {
          return new Blob([new Uint8Array(8192)], { type: 'image/jpeg' });
        }
      }
    );
    const refresh = async () => {
      let done = false;
      void refreshAvatarImage(watch.watchId, VIEWER.id, {
        kinds: [KindBaselineRecorded.make({ kind: 'stories' })],
        avatarAttempted: observed,
        ...(observed
          ? { avatar: { pictureId: 'PIC_A', pictureUrl: 'https://sanitized.invalid/avatar' } }
          : {}),
      }).then(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1_000);
    };
    await refresh();
    expect(avatarImage()).toBeUndefined();
    expect(harness.session.read('watch-store-health')).toBeUndefined();
    if (observed || room === 0) expect(harness.local.read('watch-store')).toEqual(filled);
    else
      expect(
        Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches[0]
          ?.avatarLookupAt
      ).toBeDefined();
    await vi.advanceTimersByTimeAsync(MINUTE);
    await refresh();
    expect(instagram.state.searches).toHaveLength(!observed && room > 0 ? 1 : 0);
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
