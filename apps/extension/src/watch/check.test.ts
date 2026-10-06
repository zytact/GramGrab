import { Schema } from 'effect';
import { WatchStore } from './contracts.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AccountIdSelector,
  WatchAdd,
  WatchCheck,
  WatchInboxList,
  WatchInboxRemove,
  WatchLifecycle,
  WatchRecover,
  WatchList,
  WatchShow,
  type WatchAction,
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
  storyResponse,
  type FakeInstant,
  type FakePost,
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

const addWatch = (actions: readonly WatchAction[] = ['collect'], kind: WatchKind = 'stories') =>
  run(
    WatchAdd.make({
      target: TARGET.username,
      kinds: [kind],
      actions: [actions[0]!, ...actions.slice(1)],
      acceptUnattended: true,
    }),
    'WatchAddResult'
  );

/** Runs a check once the five-minute manual-check interval has passed. */
async function checkLater() {
  await vi.advanceTimersByTimeAsync(5 * MINUTE);
  const result = await run(WatchCheck.make({ watches: [selector] }), 'WatchCheckResult');
  const outcome = result.outcomes[0]!;
  return {
    kinds: outcome.kinds.filter(
      kind => kind._tag !== 'KindCheckSkipped' || kind.reason !== 'kind-off'
    ),
  };
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
      notify: { state: 'failed', code: 'WATCH_NOTIFY_PERMISSION_DENIED' },
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

  it('records a baseline from an account without active Stories', async () => {
    await addWatch();
    instagram.state.stories[TARGET.id] = { data: { reels_media: [] } };

    expect((await checkLater()).kinds[0]?._tag).toBe('KindBaselineRecorded');
  });

  it.each([
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

describe('Posts checks', () => {
  const OLD = { id: '1', takenAt: seconds(START) - DAY / 1000 };

  /** Serves `pages` in order, chained by cursors `c1`, `c2`, and so on; the last ends the list. */
  const setPosts = (...pages: readonly (readonly FakePost[])[]) => {
    instagram.state.posts = Object.fromEntries(
      pages.map((page, index) => [
        index === 0 ? '' : `c${index}`,
        postsPage(page, index < pages.length - 1 ? `c${index + 1}` : undefined),
      ])
    );
    instagram.state.postRequests = [];
  };

  /** Posts published after the baseline below, newer for a higher number. */
  const posts = (...ids: readonly number[]) =>
    ids.map(id => ({ id: String(id), takenAt: seconds(START) + 400 + id }));

  const postsHealth = async () =>
    (await run(WatchList.make(), 'WatchListResult')).watches[0]?.kinds.find(
      kind => kind.kind === 'posts'
    );

  /** Adds a Posts Watch and records its baseline five minutes after START. */
  async function baselined() {
    await addWatch(['collect'], 'posts');
    setPosts([OLD]);
    expect((await checkLater()).kinds).toEqual([{ _tag: 'KindBaselineRecorded', kind: 'posts' }]);
    expect(instagram.state.postRequests).toEqual(['']);
  }

  it('discovers Posts, Reels, and Sidecars until a page reaches older media', async () => {
    await baselined();
    await vi.advanceTimersByTimeAsync(DAY);
    const now = seconds(Date.now());
    setPosts(
      [
        { id: '900', takenAt: now - 60, children: ['901', '902'] },
        { id: '800', takenAt: now - 120, video: false },
      ],
      [{ id: '700', takenAt: now - 180 }, OLD],
      posts(0)
    );

    const outcome = await checkLater();

    expect(outcome.kinds).toEqual([
      { _tag: 'KindCheckSucceeded', kind: 'posts', newCount: 3, catchUp: false },
    ]);
    expect(instagram.state.postRequests).toEqual(['', 'c1']);
    expect(await found()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mediaType: 'sidecar', childCount: 2 }),
        expect.objectContaining({ mediaType: 'image' }),
        expect.objectContaining({ mediaType: 'video' }),
      ])
    );
  });

  it('scans past seen Posts to an older one that became visible, until the list ends', async () => {
    await baselined();
    setPosts(posts(30));
    await checkLater();
    setPosts(posts(30), posts(20));

    const outcome = await checkLater();

    expect(outcome.kinds[0]).toMatchObject({ newCount: 1, catchUp: false });
    expect(instagram.state.postRequests).toEqual(['', 'c1']);
    expect(await found()).toHaveLength(2);
  });

  it.each([
    ['a Post newer than the one before it', [posts(5, 6)], 0],
    ['a page newer than where the last ended', [posts(6), posts(7)], 1],
    ['a Post repeated across pages', [posts(7, 6), posts(6, 5)], 2],
  ])('stops incomplete on %s and keeps its state', async (_case, pages, kept) => {
    await baselined();
    setPosts(...pages);

    const outcome = await checkLater();

    expect(outcome.kinds).toEqual([
      { _tag: 'KindCheckFailed', kind: 'posts', code: 'WATCH_CHECK_INCOMPLETE' },
    ]);
    expect(await found()).toHaveLength(kept);
    expect(await postsHealth()).toMatchObject({
      _tag: 'KindProblem',
      code: 'WATCH_CHECK_INCOMPLETE',
      lastSuccessAt: expect.any(Number),
    });
  });

  it('stops incomplete on a cursor it has already followed', async () => {
    await baselined();
    instagram.state.posts = {
      '': postsPage(posts(9), 'c1'),
      c1: postsPage(posts(8), 'c1'),
    };
    instagram.state.postRequests = [];

    expect((await checkLater()).kinds[0]).toMatchObject({ code: 'WATCH_CHECK_INCOMPLETE' });
    expect(instagram.state.postRequests).toEqual(['', 'c1']);
  });

  it('discovers a collab Post another account owns with the target as a co-author', async () => {
    await baselined();
    setPosts([{ ...posts(9)[0]!, owner: '9999', coauthors: ['9999', TARGET.id] }, OLD]);

    expect((await checkLater()).kinds[0]).toMatchObject({ newCount: 1 });
  });

  it.each([
    ['another owner', [{ ...posts(9)[0]!, owner: '9999' }]],
    [
      'another owner and only other co-authors',
      [{ ...posts(9)[0]!, owner: '9999', coauthors: ['8888'] }],
    ],
    ['a Sidecar missing its declared children', [{ ...posts(9)[0]!, children: [] }]],
    ['a non-numeric media ID', [{ ...posts(9)[0]!, id: '9x' }]],
  ])('rejects a page with %s', async (_case, page) => {
    await baselined();
    setPosts(page);

    expect((await checkLater()).kinds[0]).toMatchObject({ code: 'IG_RESPONSE_SHAPE_UNKNOWN' });
  });

  it('catches up three pages per turn within a frozen window, then completes', async () => {
    await baselined();
    await vi.advanceTimersByTimeAsync(40 * DAY);
    const now = seconds(Date.now());
    // Eligible when the traversal starts five minutes from now, but not fifteen minutes later.
    const nearWindowEdge = now - 30 * (DAY / 1000) + 6 * 60;
    setPosts(
      [
        { id: '60', takenAt: now - 10 },
        { id: '59', takenAt: now - 11 },
      ],
      [{ id: '50', takenAt: now - 30 }],
      [{ id: '40', takenAt: now - 40 }],
      [{ id: '30', takenAt: nearWindowEdge }],
      [OLD]
    );

    const first = await checkLater();

    expect(first.kinds[0]).toMatchObject({ newCount: 4, catchUp: true });
    expect(instagram.state.postRequests).toEqual(['', 'c1', 'c2']);
    expect(await postsHealth()).toMatchObject({ _tag: 'KindChecked', catchingUp: true });

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const second = await checkLater();

    expect(second.kinds[0]).toMatchObject({ newCount: 1, catchUp: false });
    expect(instagram.state.postRequests).toEqual(['', 'c1', 'c2', 'c3', 'c4']);
    expect(await postsHealth()).not.toHaveProperty('catchingUp');
  });

  it('restarts a traversal whose cursor was lost without repeating discoveries', async () => {
    await baselined();
    setPosts(posts(60), posts(50), posts(40), [...posts(30), OLD]);
    await checkLater();
    await harness.session.remove('watch-posts-traversals');

    const restarted = await checkLater();
    const finished = await checkLater();

    expect(restarted.kinds[0]).toMatchObject({ newCount: 0, catchUp: true });
    expect(finished.kinds[0]).toMatchObject({ newCount: 1, catchUp: false });
    expect(instagram.state.postRequests.slice(3)).toEqual(['', 'c1', 'c2', 'c3']);
    expect(await found()).toHaveLength(4);
  });
});

describe('Instants checks', () => {
  const setFeed = (instants: readonly FakeInstant[]) =>
    (instagram.state.instants = instantsFeed(instants));

  async function baselined() {
    await addWatch(['collect'], 'instants');
    expect((await checkLater()).kinds).toEqual([
      { _tag: 'KindBaselineRecorded', kind: 'instants' },
    ]);
    const store = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store'));
    const cutoff = store.watches[0]?.tracking.instants?.baselineCutoff;
    if (cutoff === undefined) throw new Error('The Instant baseline was not persisted.');
    return cutoff;
  }

  it("keeps the target's Instants from anywhere in a mixed-order feed", async () => {
    const cutoff = await baselined();
    setFeed([
      { pk: '11', owner: '7777', takenAt: cutoff + 30 },
      { pk: '12', owner: TARGET.id, takenAt: cutoff + 10 },
      { pk: '13', owner: TARGET.id, takenAt: cutoff },
      { pk: '14', owner: TARGET.id, takenAt: cutoff + 20, video: true },
    ]);

    const outcome = await checkLater();
    await checkLater();

    expect(outcome.kinds).toEqual([
      { _tag: 'KindCheckSucceeded', kind: 'instants', newCount: 2, catchUp: false },
    ]);
    expect((await found()).map(entry => entry.mediaType).sort()).toEqual(['image', 'video']);
  });

  it.each([
    ['an ID bound to another owner', { id: '15_7777' }],
    ['a future publication time', { taken_at: 9e9 }],
    ['an unknown item', { __typename: 'XDTSomethingNew' }],
  ])('cannot establish a baseline from a feed with %s', async (_case, change) => {
    await addWatch(['collect'], 'instants');
    const feed = instantsFeed([{ pk: '15', owner: TARGET.id, takenAt: seconds(START) }]);
    const [item] = feed.data.xdt_get_quick_snaps.items_ordered_by_time;
    instagram.state.instants = {
      data: {
        xdt_get_quick_snaps: {
          ...feed.data.xdt_get_quick_snaps,
          items_ordered_by_time: [{ ...item, ...change }],
        },
      },
    };

    expect((await checkLater()).kinds).toEqual([
      { _tag: 'KindCheckFailed', kind: 'instants', code: 'IG_RESPONSE_SHAPE_UNKNOWN' },
    ]);
    expect((await run(WatchList.make(), 'WatchListResult')).watches[0]?.kinds).toContainEqual({
      _tag: 'KindProblem',
      kind: 'instants',
      code: 'IG_RESPONSE_SHAPE_UNKNOWN',
      since: expect.any(Number),
    });
  });
});

describe('Avatar checks', () => {
  const setPicture = (pictureId?: string) =>
    (instagram.state.search = avatarSearch({ ...TARGET, pictureId }));

  const lastPicture = () =>
    (
      harness.local.read('watch-store') as {
        watches: { tracking: { avatar?: { pictureId?: string } } }[];
      }
    ).watches[0]!.tracking.avatar?.pictureId;

  it('counts every new picture identity, A to B to A included, and ignores URL changes', async () => {
    await addWatch(['collect'], 'avatar');
    expect((await checkLater()).kinds).toEqual([{ _tag: 'KindBaselineRecorded', kind: 'avatar' }]);

    const counts = [];
    for (const picture of ['PIC_A', 'PIC_B', 'PIC_B', 'PIC_A']) {
      setPicture(picture);
      counts.push((await checkLater()).kinds[0]);
    }

    expect(
      counts.map(outcome => outcome?._tag === 'KindCheckSucceeded' && outcome.newCount)
    ).toEqual([0, 1, 0, 1]);
    expect((await found()).map(entry => entry.mediaType)).toEqual(['avatar', 'avatar']);
    expect(instagram.state.searches.every(query => query === TARGET.username)).toBe(true);
  });

  it('compares with the last picture after a pause longer than 30 days', async () => {
    await addWatch(['collect'], 'avatar');
    await checkLater();
    await run(
      WatchLifecycle.make({ operation: 'pause', watches: [selector] }),
      'WatchLifecycleResult'
    );
    await vi.advanceTimersByTimeAsync(40 * DAY);
    await run(
      WatchLifecycle.make({ operation: 'resume', watches: [selector] }),
      'WatchLifecycleResult'
    );
    setPicture('PIC_B');

    expect((await checkLater()).kinds[0]).toMatchObject({ newCount: 1 });
  });

  it.each([
    ['no picture identity', avatarSearch({ ...TARGET })],
    ...['pk', 'pk_id', 'id'].map((field): [string, unknown] => [
      `conflicting ${field}`,
      {
        users: [
          {
            user: {
              pk: TARGET.id,
              pk_id: TARGET.id,
              id: TARGET.id,
              username: TARGET.username,
              profile_pic_id: 'PIC_B',
              [field]: '9999',
            },
          },
        ],
      },
    ]),
    [
      'only another account',
      avatarSearch({ id: '9999', username: TARGET.username, pictureId: 'PIC_B' }),
    ],
    [
      'two records for the target',
      avatarSearch({ ...TARGET, pictureId: 'PIC_B' }, { ...TARGET, pictureId: 'PIC_C' }),
    ],
  ])('keeps the last picture when the answer has %s', async (_case, search) => {
    await addWatch(['collect'], 'avatar');
    await checkLater();
    instagram.state.search = search;

    expect((await checkLater()).kinds).toEqual([
      { _tag: 'KindCheckFailed', kind: 'avatar', code: 'IG_RESPONSE_SHAPE_UNKNOWN' },
    ]);
    expect(lastPicture()).toBe('PIC_A');
  });

  it('follows a verified rename before looking the account up', async () => {
    await addWatch(['collect'], 'avatar');
    const renamed = { ...TARGET, username: 'target.renamed' };
    instagram.state.profile = {
      data: { user: { id: TARGET.id, pk: TARGET.id, username: renamed.username } },
    };
    instagram.state.search = avatarSearch({ ...renamed, pictureId: 'PIC_A' });

    await checkLater();

    expect(instagram.state.searches).toEqual([renamed.username]);
    expect((await run(WatchShow.make({ watch: selector }), 'WatchShowResult')).watch).toMatchObject(
      {
        username: renamed.username,
        formerUsername: TARGET.username,
      }
    );
  });

  it('checks neither Avatar nor Posts when the username cannot be confirmed', async () => {
    await run(
      WatchAdd.make({
        target: TARGET.username,
        kinds: ['avatar', 'posts'],
        actions: ['collect'],
        acceptUnattended: true,
      }),
      'WatchAddResult'
    );
    instagram.state.profile = { data: { user: { id: '9999', username: 'someone.else' } } };

    expect((await checkLater()).kinds).toEqual([
      { _tag: 'KindCheckFailed', kind: 'avatar', code: 'WATCH_USERNAME_UNCONFIRMED' },
      { _tag: 'KindCheckFailed', kind: 'posts', code: 'WATCH_USERNAME_UNCONFIRMED' },
    ]);
    expect(instagram.state.searches).toEqual([]);
    expect(instagram.state.postRequests).toEqual([]);
  });
});

describe('Watch notifications', () => {
  const allowNotifications = () => harness.grantedPermissions.add('notifications');

  /** A Watch of Stories that notifies and collects, past its baseline. */
  async function notifying(kinds: readonly WatchKind[] = ['stories']) {
    await run(
      WatchAdd.make({
        target: TARGET.username,
        kinds: [kinds[0]!, ...kinds.slice(1)],
        actions: ['notify', 'collect'],
        acceptUnattended: true,
      }),
      'WatchAddResult'
    );
    await checkLater();
  }

  const newStories = (...ids: readonly string[]) =>
    setStories(ids.map(id => ({ id, takenAt: seconds(Date.now()) + 60 })));

  const list = () => run(WatchList.make(), 'WatchListResult');

  it('sends one summary per check, with notify and collect recorded independently', async () => {
    allowNotifications();
    await notifying();
    newStories('101', '102');

    await checkLater();

    expect([...harness.notifications.values()]).toEqual([
      expect.objectContaining({ title: `@${TARGET.username}`, message: '2 new Stories' }),
    ]);
    expect(await found()).toEqual([
      expect.objectContaining({ notify: { state: 'done' }, collect: { state: 'done' } }),
      expect.objectContaining({ notify: { state: 'done' }, collect: { state: 'done' } }),
    ]);
  });

  it('keeps a refused notification in Needs you until it is retried', async () => {
    await notifying();
    newStories('201');
    await checkLater();
    const [entry] = (await list()).attentionEntries;

    expect(entry?.notify).toEqual({ state: 'failed', code: 'WATCH_NOTIFY_PERMISSION_DENIED' });
    await checkLater();
    expect(harness.notifications.size).toBe(0);

    allowNotifications();
    const retried = await run(
      WatchRecover.make({ action: 'notify', operation: 'retry', entryIds: [entry!.entryId] }),
      'WatchRecoverResult'
    );

    expect(retried.recoveredEntryIds).toEqual([entry!.entryId]);
    expect(harness.notifications.size).toBe(1);
    expect((await list()).attentionEntries).toEqual([]);
  });

  it('dismisses a failed delivery once, and refuses or reports anything else', async () => {
    allowNotifications();
    harness.failNotifications(new Error('not shown'));
    await notifying();
    newStories('301');
    await checkLater();
    const [entry] = (await list()).attentionEntries;
    expect(entry?.notify?.code).toBe('WATCH_NOTIFY_FAILED');

    const dismiss = () =>
      run(
        WatchRecover.make({
          action: 'notify',
          operation: 'dismiss',
          entryIds: [entry!.entryId, 'missing'],
        }),
        'WatchRecoverResult'
      );

    expect(await dismiss()).toMatchObject({
      recoveredEntryIds: [entry!.entryId],
      unknownEntryIds: ['missing'],
    });
    expect((await dismiss()).refused).toEqual([
      { entryId: entry!.entryId, code: 'WATCH_RECOVERY_NOT_APPLICABLE' },
    ]);
    expect((await list()).attentionCount).toBe(0);
  });

  it('announces a kind that starts failing once, not on every failed check', async () => {
    allowNotifications();
    await notifying();
    instagram.state.storyStatus = 500;

    await checkLater();
    await checkLater();

    expect([...harness.notifications.values()].map(shown => shown.message)).toEqual([
      'Stories: Connection problem',
    ]);
  });

  it('uses the Avatar as the icon, and GramGrab’s icon when the browser refuses it', async () => {
    allowNotifications();
    harness.failNotificationIcons(true);
    await notifying(['avatar']);
    instagram.state.search = avatarSearch({ ...TARGET, pictureId: 'PIC_B' });

    await checkLater();

    expect(harness.browser.notifications.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ iconUrl: expect.stringMatching(/^data:/) })
    );
    expect([...harness.notifications.values()]).toEqual([
      expect.objectContaining({
        message: '1 Avatar change',
        iconUrl: 'chrome-extension://test/icons/icon-96.png',
      }),
    ]);
    expect([...harness.notifications.values()][0]).not.toHaveProperty('buttons');
  });

  it("opens the notified Watch's page when the notification is clicked", async () => {
    allowNotifications();
    await notifying();
    newStories('401');
    await checkLater();
    const watchId = (await list()).watches[0]!.watchId;

    harness.clickNotification([...harness.notifications.keys()][0]!);

    expect(harness.browser.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/options.html#watch=${watchId}`,
    });
  });
});
