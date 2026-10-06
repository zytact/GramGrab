import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  WatchAdd,
  WatchCheck,
  WatchInboxList,
  WatchInboxRemove,
  WatchList,
  WatchShow,
  type WatchAction,
  type WatchCommand,
  type WatchResult,
} from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import {
  TARGET,
  createWatchInstagram,
  storyResponse,
  type FakeStory,
} from '../test/watch-instagram.ts';
import type { WatchCommandResponse } from '../messaging/contracts.ts';

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

const selector = AccountIdSelector.make({ accountId: TARGET.id });
const seconds = (time: number) => Math.floor(time / 1000);

const setStories = (stories: readonly FakeStory[]) =>
  (instagram.state.stories[TARGET.id] = storyResponse(TARGET.id, stories));

const addWatch = (actions: readonly WatchAction[] = ['collect']) =>
  run(
    WatchAdd.make({
      target: TARGET.username,
      kinds: ['stories'],
      actions: [actions[0]!, ...actions.slice(1)],
      acceptUnattended: true,
    }),
    'WatchAddResult'
  );

/** Runs a check once the five-minute manual-check interval has passed. */
async function checkLater() {
  await vi.advanceTimersByTimeAsync(5 * MINUTE);
  const result = await run(WatchCheck.make({ watches: [selector] }), 'WatchCheckResult');
  return result.outcomes[0]!;
}

const found = async () =>
  (await run(WatchShow.make({ watch: selector }), 'WatchShowResult')).discoveries;

describe('Story checks', () => {
  it('records a baseline without actions, then discovers only media after its cutoff', async () => {
    await addWatch();
    setStories([{ id: '11', takenAt: seconds(START) - 3600 }]);

    const baseline = await checkLater();
    expect(baseline.kinds).toEqual([{ _tag: 'KindBaselineRecorded', kind: 'stories' }]);
    expect(await found()).toEqual([]);

    const cutoff = (
      harness.local.read('watch-store') as {
        watches: { tracking: { stories: { baselineCutoff: number } } }[];
      }
    ).watches[0]!.tracking.stories.baselineCutoff;
    setStories([
      { id: '11', takenAt: seconds(START) - 3600 },
      { id: '12', takenAt: cutoff },
      { id: '13', takenAt: cutoff + 1, video: false },
    ]);
    const next = await checkLater();

    expect(next.kinds).toEqual([
      { _tag: 'KindCheckSucceeded', kind: 'stories', newCount: 1, catchUp: false },
    ]);
    expect(await found()).toMatchObject([{ kind: 'stories', mediaType: 'image' }]);
  });

  it('leaves media published during initialization eligible for the next check', async () => {
    await addWatch();
    const published = seconds(Date.now() + 5 * MINUTE) + 30;
    setStories([{ id: '21', takenAt: published }]);

    await checkLater();
    expect(await found()).toEqual([]);
    const next = await checkLater();

    expect(next.kinds[0]).toMatchObject({ newCount: 1 });
  });

  it('collects each Story once and keeps it seen after removal from the inbox', async () => {
    await addWatch(['collect', 'notify']);
    await checkLater();
    setStories([{ id: '31', takenAt: seconds(Date.now()) + 60 }]);

    await checkLater();
    await checkLater();
    const inbox = await run(WatchInboxList.make({}), 'WatchInboxListResult');
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]).toMatchObject({
      collect: { state: 'done' },
      notify: { state: 'waiting' },
      inboxUntil: inbox.entries[0]!.discoveredAt + 30 * DAY,
    });

    await run(
      WatchInboxRemove.make({ entryIds: [inbox.entries[0]!.entryId] }),
      'WatchInboxRemoveResult'
    );
    await checkLater();

    expect((await run(WatchInboxList.make({}), 'WatchInboxListResult')).entries).toEqual([]);
    expect(await found()).toHaveLength(1);
  });

  it('accepts an identified reel holding only expired Stories as a baseline', async () => {
    await addWatch();
    setStories([{ id: '41', takenAt: seconds(START) - 2 * 86_400 }]);

    expect((await checkLater()).kinds[0]?._tag).toBe('KindBaselineRecorded');
  });

  it.each([
    ['a missing collection', { data: { reels_media: [] } }],
    ['another owner', storyResponse('9999', [])],
    [
      'an acquisition error',
      { ...storyResponse(TARGET.id, []), errors: [{ path: ['reels_media'] }] },
    ],
    ['a future publication time', storyResponse(TARGET.id, [{ id: '51', takenAt: 9e9 }])],
    ['an unsafe ID', storyResponse(TARGET.id, [{ id: '5x1', takenAt: seconds(START) }])],
  ])('cannot establish a baseline from %s', async (_case, response) => {
    await addWatch();
    instagram.state.stories[TARGET.id] = response;

    const outcome = await checkLater();

    expect(outcome.kinds).toEqual([
      { _tag: 'KindCheckFailed', kind: 'stories', code: 'IG_RESPONSE_SHAPE_UNKNOWN' },
    ]);
    const listed = await run(WatchList.make(), 'WatchListResult');
    expect(listed.attentionCount).toBe(1);
    expect(listed.watches[0]?.kinds.find(kind => kind.kind === 'stories')?._tag).toBe(
      'KindProblem'
    );
    expect(harness.badge).toBe('1');
  });

  it('keeps the baseline through a failed check and clears the problem on success', async () => {
    await addWatch();
    await checkLater();
    instagram.state.storyStatus = 500;
    setStories([{ id: '61', takenAt: seconds(Date.now()) + 60 }]);

    expect((await checkLater()).kinds[0]?._tag).toBe('KindCheckFailed');
    instagram.state.storyStatus = 200;
    const recovered = await checkLater();

    expect(recovered.kinds[0]).toMatchObject({ _tag: 'KindCheckSucceeded', newCount: 1 });
    expect((await run(WatchList.make(), 'WatchListResult')).attentionCount).toBe(0);
    expect(harness.badge).toBe('');
  });

  it('defers a manual check within five minutes of the last one', async () => {
    await addWatch();
    await checkLater();

    const result = await run(WatchCheck.make({ watches: [selector] }), 'WatchCheckResult');

    expect(result.outcomes[0]?.kinds).toEqual([]);
    expect(result.outcomes[0]?.deferredUntil).toBeGreaterThan(Date.now());
  });

  it('stops before recording a discovery the store cannot save', async () => {
    await addWatch();
    await checkLater();
    setStories([{ id: '71', takenAt: seconds(Date.now()) + 60 }]);
    harness.local.failWrites = true;

    expect((await checkLater()).kinds).toEqual([
      { _tag: 'KindCheckSkipped', kind: 'stories', reason: 'storage' },
    ]);
    harness.local.failWrites = false;

    expect((await checkLater()).kinds[0]).toMatchObject({ newCount: 1 });
  });

  it('drops collected entries from the inbox after 30 days', async () => {
    await addWatch();
    await checkLater();
    setStories([{ id: '81', takenAt: seconds(Date.now()) + 60 }]);
    await checkLater();

    await vi.advanceTimersByTimeAsync(30 * DAY);

    expect((await run(WatchInboxList.make({}), 'WatchInboxListResult')).entries).toEqual([]);
  });
});
