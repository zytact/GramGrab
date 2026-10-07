import { Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  WatchAdd,
  WatchCheck,
  WatchList,
  WatchLifecycle,
  type WatchCommand,
  type WatchResult,
} from '@gramgrab/protocol';
import { createExtensionHarness, json, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, createWatchInstagram, postsPage, storyResponse } from '../test/watch-instagram.ts';
import type { WatchKind } from '@gramgrab/protocol';
import type { WatchCommandResponse } from '../messaging/contracts.ts';
import { WatchStore } from './contracts.ts';

const START = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OTHER = { id: '3003', username: 'target.two' };

let harness: ExtensionHarness;
let instagram: ReturnType<typeof createWatchInstagram>;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  harness = createExtensionHarness();
  instagram = createWatchInstagram();
  instagram.state.accounts[OTHER.username] = { id: OTHER.id };
  harness.setFetch((url, init) => {
    if (init?.body instanceof URLSearchParams && init.body.get('doc_id') === '28036671149327607') {
      const id = JSON.parse(init.body.get('variables') ?? '{}').id as string;
      const username = id === OTHER.id ? OTHER.username : TARGET.username;
      return json({ data: { user: { id, username } } });
    }
    return instagram.handle(url, init);
  });
  await harness.session.set({ 'watch-browser-session': true });
  await harness.loadWorker();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

const add = (username: string, kinds: readonly [WatchKind, ...WatchKind[]] = ['stories']) =>
  run(
    WatchAdd.make({
      target: username,
      kinds,
      actions: ['collect'],
      acceptUnattended: true,
    }),
    'WatchAddResult'
  );

/** Story requests made so far, in order, by target ID. */
const storyRequests = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input))
    .filter(url => url.searchParams.get('query_hash') === '45246d3fe16ccc6577e0bd297a5db1ab')
    .map(url => JSON.parse(url.searchParams.get('variables') ?? '{}').reel_ids[0] as string);

/** Every Story and Posts request so far, in order, as `stories:<target>` or `posts:<cursor>`. */
const acquisitions = () =>
  vi.mocked(globalThis.fetch).mock.calls.flatMap(([input, init]) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.searchParams.get('query_hash') === '45246d3fe16ccc6577e0bd297a5db1ab')
      return [`stories:${JSON.parse(url.searchParams.get('variables') ?? '{}').reel_ids[0]}`];
    const body = init?.body instanceof URLSearchParams ? init.body : undefined;
    if (!body?.get('variables')?.includes('"username"')) return [];
    return [`posts:${JSON.parse(body.get('variables')!).after ?? ''}`];
  });

/** Delivers the periodic alarm and lets the work it starts run on the fake clock. */
async function wake(minutes = 3) {
  harness.fireAlarm('watch-pump');
  await vi.advanceTimersByTimeAsync(minutes * MINUTE);
}

const schedule = async () => (await run(WatchList.make(), 'WatchListResult')).schedule;

describe('Watch scheduling', () => {
  it('makes no idle requests between rounds or while all Watches are paused', async () => {
    await add(TARGET.username);
    await wake();
    expect(storyRequests()).toEqual([TARGET.id]);
    vi.mocked(globalThis.fetch).mockClear();
    for (let minute = 0; minute < 60; minute++) await wake(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await run(
      WatchLifecycle.make({
        operation: 'pause',
        watches: [AccountIdSelector.make({ accountId: TARGET.id })],
      }),
      'WatchLifecycleResult'
    );
    vi.mocked(globalThis.fetch).mockClear();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    await wake();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('orders single-kind Watches by their selected-kind success time', async () => {
    await add(TARGET.username);
    await add(OTHER.username);
    const store = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
    harness.local.write('watch-store', {
      ...store,
      watches: store.watches.map(watch => ({
        ...watch,
        tracking: {
          stories: {
            baselineCutoff: Math.floor(START / 1000),
            lastSuccessAt: START - (watch.targetId === TARGET.id ? HOUR : 2 * HOUR),
          },
        },
      })),
    });

    await wake(4);
    expect(storyRequests()).toEqual([OTHER.id, TARGET.id]);
  });

  it('suspends a round when the login changes between Watches', async () => {
    await add(TARGET.username);
    await add(OTHER.username);
    harness.setFetch((url, init) => {
      const response = instagram.handle(url, init);
      if (new URL(url).searchParams.get('query_hash') === '45246d3fe16ccc6577e0bd297a5db1ab')
        instagram.state.viewer = { id: '4004', username: 'instagram' };
      return response;
    });

    await wake();
    expect(storyRequests()).toEqual([TARGET.id]);
    expect(harness.local.read('watch-scheduler')).toMatchObject({ suspended: true });
    const store = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
    expect(
      store.watches.find(watch => watch.targetId === OTHER.id)?.tracking.stories
    ).toBeUndefined();
    await harness.loadWorker();
    await wake();
    expect(storyRequests()).toEqual([TARGET.id]);
  });

  it.each(['changed', 'unverifiable'])(
    'suspends remaining kinds when the login is %s',
    async mode => {
      await add(TARGET.username, ['stories', 'posts']);
      vi.mocked(globalThis.fetch).mockClear();
      harness.setFetch((url, init) => {
        const response = instagram.handle(url, init);
        if (new URL(url).searchParams.get('query_hash') === '45246d3fe16ccc6577e0bd297a5db1ab')
          instagram.state.viewer =
            mode === 'changed' ? { id: '4004', username: 'instagram' } : null;
        return response;
      });

      await wake();
      expect(acquisitions()).toEqual([`stories:${TARGET.id}`]);
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.some(
            ([, init]) =>
              init?.body instanceof URLSearchParams &&
              init.body.get('doc_id') === '28036671149327607'
          )
      ).toBe(false);
      const store = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
      expect(store.watches[0]?.tracking.stories?.lastSuccessAt).toBeTypeOf('number');
      expect(store.watches[0]?.tracking.posts).toBeUndefined();
      expect(store.watches[0]?.discoveries).toEqual([]);
      expect(harness.local.read('watch-scheduler')).toMatchObject({ suspended: true });
      const attempts = vi.mocked(globalThis.fetch).mock.calls.length;
      await harness.loadWorker();
      await wake();
      expect(globalThis.fetch).toHaveBeenCalledTimes(attempts);
    }
  );

  it('keeps exactly one periodic alarm and recreates it when the browser dropped it', async () => {
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.alarms.get('watch-pump')).toMatchObject({ periodInMinutes: 1 });
    const created = vi.mocked(harness.browser.alarms.create).mock.calls.length;

    harness.fireInstalled('update');
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.browser.alarms.create).toHaveBeenCalledTimes(created);

    harness.alarms.clear();
    harness.fireStartup();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.alarms.get('watch-pump')).toMatchObject({ periodInMinutes: 1 });
  });

  it('holds a new browser session without a startup event and preserves the deadline across worker restarts', async () => {
    const hold = () =>
      Schema.decodeUnknownSync(Schema.Struct({ startupHoldUntil: Schema.Number }))(
        harness.local.read('watch-scheduler')
      ).startupHoldUntil;
    await harness.session.remove('watch-browser-session');
    await harness.loadWorker();
    await vi.advanceTimersByTimeAsync(0);
    await add(TARGET.username);
    const original = hold();
    await vi.advanceTimersByTimeAsync(30_000);
    await harness.loadWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(hold()).toBe(original);
    await wake(1);
    expect(storyRequests()).toEqual([]);
    await harness.session.remove('watch-browser-session');
    await harness.loadWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(hold()).toBe(Date.now() + 2 * MINUTE);
    await wake(1);
    expect(storyRequests()).toEqual([]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    await wake(2);
    expect(storyRequests()).toEqual([TARGET.id]);
  });

  it('runs a round oldest-first, then waits 12 hours less jitter for the next', async () => {
    await add(TARGET.username);
    await add(OTHER.username);

    await wake(4);
    expect(storyRequests()).toEqual([TARGET.id, OTHER.id]);
    const next = (await schedule()).nextRoundAt!;
    expect(next - START).toBeGreaterThanOrEqual(0.9 * 12 * HOUR);
    expect(next - START).toBeLessThan(0.9 * 12 * HOUR + 10 * MINUTE);

    await wake();
    expect(storyRequests()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(next - Date.now());
    await wake();
    expect(storyRequests()).toHaveLength(4);
  });

  it('holds overdue work for two minutes after the browser starts', async () => {
    await add(TARGET.username);
    harness.fireStartup();
    await vi.advanceTimersByTimeAsync(0);

    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(storyRequests()).toEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE + 1_000);
    await wake();
    expect(storyRequests()).toEqual([TARGET.id]);
  });

  it('resumes a round after the worker restarts mid-round', async () => {
    await add(TARGET.username);
    await add(OTHER.username);
    harness.fireAlarm('watch-pump');
    while (storyRequests().length === 0) await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await harness.loadWorker();
    await wake();

    expect(new Set(storyRequests())).toEqual(new Set([TARGET.id, OTHER.id]));
  });

  it('retries a kind that broke once, an hour later, and only that once', async () => {
    await add(TARGET.username);
    instagram.state.storyStatus = 500;

    await wake();
    const failed = storyRequests().length;
    await vi.advanceTimersByTimeAsync(HOUR);
    await wake();
    const retried = storyRequests().length;
    await vi.advanceTimersByTimeAsync(HOUR);
    await wake();

    expect(retried).toBeGreaterThan(failed);
    expect(storyRequests()).toHaveLength(retried);
  });

  it('pauses every Watch after a 429 and shows one attention item with the pause end', async () => {
    await add(TARGET.username);
    await add(OTHER.username);
    instagram.state.storyStatus = 429;

    await wake();
    const listed = await run(WatchList.make(), 'WatchListResult');

    expect(storyRequests()).toEqual([TARGET.id]);
    expect(listed.schedule.pausedUntil).toBeGreaterThan(Date.now());
    expect(listed.attentionCount).toBe(1);
    expect(harness.badge).toBe('1');
  });

  it("never runs another login's Watches", async () => {
    await add(TARGET.username);
    instagram.state.viewer = { id: '4004', username: 'someone.else' };

    await wake();

    expect(storyRequests()).toEqual([]);
  });

  it('suspends unverifiable login work through reload until a person verifies the login', async () => {
    await add(TARGET.username);
    harness.setFetch(() => json({ data: {} }));
    await wake();
    expect(harness.local.read('watch-scheduler')).toMatchObject({ suspended: true });
    const attempts = vi.mocked(globalThis.fetch).mock.calls.length;
    await harness.loadWorker();
    await wake();
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(attempts);
    expect(storyRequests()).toEqual([]);

    harness.setFetch(instagram.handle);
    await run(WatchList.make(), 'WatchListResult');
    await wake();
    expect(storyRequests()).toEqual([TARGET.id]);
  });

  it('runs a manual check at once without moving the next round', async () => {
    await add(TARGET.username);
    await wake();
    const before = (await schedule()).nextRoundAt;
    instagram.state.stories[TARGET.id] = storyResponse(TARGET.id, []);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await run(
      WatchCheck.make({ watches: [AccountIdSelector.make({ accountId: TARGET.id })] }),
      'WatchCheckResult'
    );

    expect(storyRequests()).toHaveLength(2);
    expect((await schedule()).nextRoundAt).toBe(before);
  });

  it('continues a long Posts traversal after the rest of the round had its turn', async () => {
    await add(TARGET.username, ['stories', 'posts']);
    await add(OTHER.username);
    await wake(5);
    const baselines = acquisitions().length;
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    const now = Math.floor(Date.now() / 1000);
    instagram.state.posts = Object.fromEntries(
      [0, 1, 2, 3].map(page => [
        page === 0 ? '' : `c${page}`,
        postsPage(
          [{ id: String(90 - page), takenAt: now - page }],
          page < 3 ? `c${page + 1}` : undefined
        ),
      ])
    );

    await wake(5);
    await wake();

    expect(acquisitions().slice(baselines)).toEqual([
      `stories:${TARGET.id}`,
      'posts:',
      'posts:c1',
      'posts:c2',
      `stories:${OTHER.id}`,
      'posts:c3',
    ]);
  });

  it('shares one Instants feed between the Watches of a round, and only that round', async () => {
    await add(TARGET.username, ['instants']);
    await add(OTHER.username, ['instants']);

    await wake();
    expect(instagram.state.instantsRequests).toBe(1);
    const next = (await schedule()).nextRoundAt!;
    await vi.advanceTimersByTimeAsync(next - Date.now());
    await wake();

    expect(instagram.state.instantsRequests).toBe(2);
  });
});
