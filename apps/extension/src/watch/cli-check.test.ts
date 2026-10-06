import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  Event,
  WatchAdd,
  WatchCheck,
  WatchList,
  type EventPayload,
} from '@gramgrab/protocol';
import { Schema } from 'effect';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, createWatchInstagram } from '../test/watch-instagram.ts';
import type { WatchCommandResponse } from '../messaging/contracts.ts';

const START = Date.UTC(2026, 9, 1, 12);
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
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

async function settled<T>(promise: Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  void promise.then(value => {
    result = { value };
  });
  while (!result) await vi.advanceTimersByTimeAsync(1_000);
  return result.value;
}
async function add(kinds: readonly ['stories'] | readonly ['stories', 'posts'] = ['stories']) {
  await settled(
    harness.command(
      WatchAdd.make({
        target: TARGET.username,
        kinds,
        actions: ['collect'],
        acceptUnattended: true,
      })
    )
  );
}
const check = () =>
  WatchCheck.make({
    watches: [
      AccountIdSelector.make({ accountId: TARGET.id }),
      AccountIdSelector.make({ accountId: '9999' }),
    ],
  });
const storyRequests = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([url]) =>
      (url instanceof Request ? url.url : url.toString()).includes(
        '45246d3fe16ccc6577e0bd297a5db1ab'
      )
    ).length;

describe('native Watch checks', () => {
  it('emits accepted, each registered kind, and one terminal result while retaining unknown selectors', async () => {
    await add();
    const events: EventPayload[] = [];
    const terminal = await settled(harness.command(check(), event => events.push(event)));
    expect(events[0]?._tag).toBe('Accepted');
    const kinds = events.flatMap(event =>
      event._tag === 'Progress' && event.watchCheck ? [event.watchCheck] : []
    );
    expect(new Set(kinds.map(event => event.kind))).toEqual(
      new Set(['stories', 'posts', 'instants', 'avatar'])
    );
    expect(kinds.find(event => event.kind === 'stories')?.outcome._tag).toBe(
      'KindBaselineRecorded'
    );
    expect(terminal).toMatchObject({
      _tag: 'Completed',
      result: { _tag: 'WatchCheckResult', unknownWatches: ['9999'] },
    });
    expect(events.filter(event => event._tag === 'Completed')).toHaveLength(1);
    expect(harness.local.read('watch-scheduler')).toMatchObject({
      logins: { '1001': { manual: [] } },
    });
  });

  it('admits one concurrent check per Watch and defers the other without duplicate acquisition', async () => {
    await add();
    const terminals = await settled(
      Promise.all([harness.command(check()), harness.command(check())])
    );
    const results = terminals.flatMap(terminal =>
      terminal._tag === 'Completed' && terminal.result._tag === 'WatchCheckResult'
        ? [terminal.result]
        : []
    );
    expect(results).toHaveLength(2);
    expect(results.filter(result => result.outcomes[0]?.deferredUntil !== undefined)).toHaveLength(
      1
    );
    expect(storyRequests()).toBe(1);
    expect(harness.local.read('watch-scheduler')).toMatchObject({
      logins: { '1001': { manual: [] } },
    });
  });

  it('reports the maximum pacing hold without moving the next round', async () => {
    await add();
    harness.local.write('instagram-requests', {
      version: 1,
      attempts: Array.from({ length: 60 }, () => START - 10 * 60_000),
      nextWatchAt: START + 20 * 60_000,
      pause: { until: START + 30 * 60_000, level: 0, probing: false },
    });
    harness.local.write('watch-scheduler', {
      version: 1,
      logins: {
        '1001': { nextRoundAt: START + 12 * 60 * 60_000, remaining: [], earlyRetries: [] },
      },
    });
    await harness.loadWorker();
    const terminal = await settled(harness.command(check()));
    expect(terminal).toMatchObject({
      _tag: 'Completed',
      result: { outcomes: [{ deferredUntil: START + 50 * 60_000, kinds: [] }] },
    });
    expect(storyRequests()).toBe(0);
    expect(harness.local.read('watch-scheduler')).toMatchObject({
      logins: { '1001': { nextRoundAt: START + 12 * 60 * 60_000 } },
    });
  });

  it('cancels transport output while the durable check completes in the background', async () => {
    await add();
    const events: EventPayload[] = [];
    void harness.command(check(), event => events.push(event));
    const accepted = Schema.decodeUnknownSync(Event)(harness.nativeMessages.at(-2));
    harness.cancel(accepted.requestId);
    const count = events.length;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(events).toHaveLength(count);
    expect(storyRequests()).toBe(1);
    const listed = await settled(
      harness.send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command: WatchList.make() })
    );
    expect(listed.result).toMatchObject({
      watches: [
        {
          kinds: expect.arrayContaining([
            {
              _tag: 'KindChecked',
              kind: 'stories',
              catchingUp: false,
              lastSuccessAt: expect.any(Number),
              lastCheckAt: expect.any(Number),
            },
          ]),
        },
      ],
    });
    expect(harness.local.read('watch-scheduler')).toMatchObject({
      logins: { '1001': { manual: [] } },
    });
  });

  it('resumes only unfinished kinds after worker interruption', async () => {
    await add(['stories', 'posts']);
    let profileStarted = false;
    let reloaded = false;
    harness.setFetch((url, init) => {
      if (
        !reloaded &&
        init?.body instanceof URLSearchParams &&
        init.body.get('doc_id') === '28036671149327607'
      ) {
        profileStarted = true;
        return new Promise<Response>(() => {});
      }
      return instagram.handle(url, init);
    });
    const events: EventPayload[] = [];
    void harness.command(check(), event => events.push(event));
    while (
      !events.some(
        event =>
          event._tag === 'Progress' && event.watchCheck?.outcome._tag === 'KindBaselineRecorded'
      )
    )
      await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.local.read('watch-scheduler')).toMatchObject({
      logins: { '1001': { manual: [{ remainingKinds: ['posts'] }] } },
    });
    while (!profileStarted) await vi.advanceTimersByTimeAsync(1_000);
    reloaded = true;
    await harness.loadWorker();
    harness.fireAlarm('watch-pump');
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(storyRequests()).toBe(1);
    expect(harness.local.read('watch-scheduler')).toMatchObject({
      logins: { '1001': { manual: [] } },
    });
  });

  it('stops remaining kinds when the creating login changes and refuses unpersisted work', async () => {
    await add(['stories', 'posts']);
    vi.mocked(globalThis.fetch).mockClear();
    const events: EventPayload[] = [];
    const terminal = await settled(
      harness.command(check(), event => {
        events.push(event);
        if (event._tag === 'Progress' && event.watchCheck?.kind === 'stories')
          instagram.state.viewer = { id: '3003', username: 'instagram' };
      })
    );
    expect(terminal).toMatchObject({
      _tag: 'Completed',
      result: {
        outcomes: [
          {
            kinds: expect.arrayContaining([
              { _tag: 'KindCheckSkipped', kind: 'posts', reason: 'login-unverified' },
            ]),
          },
        ],
      },
    });
    expect(
      vi
        .mocked(globalThis.fetch)
        .mock.calls.some(
          ([, init]) =>
            init?.body instanceof URLSearchParams &&
            (init.body.get('variables')?.includes('"username"') ||
              init.body.get('doc_id') === '28036671149327607')
        )
    ).toBe(false);
    instagram.state.viewer = { id: '1001', username: 'instagram' };
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    harness.local.failWrites = true;
    const rejected = await settled(harness.command(check()));
    expect(rejected).toMatchObject({
      _tag: 'Completed',
      result: {
        outcomes: [
          {
            kinds: [
              { _tag: 'KindCheckSkipped', kind: 'stories', reason: 'storage' },
              { _tag: 'KindCheckSkipped', kind: 'posts', reason: 'storage' },
            ],
          },
        ],
      },
    });
    expect(storyRequests()).toBe(1);
  });
});
