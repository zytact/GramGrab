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
  type CommandFailure,
  type WatchCommand,
} from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
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

  it('rejects fields outside the allowlist', async () => {
    await addTarget();
    const stored = harness.local.read('watch-store') as { watches: Record<string, unknown>[] };
    stored.watches[0]!.caption = 'not allowed';
    harness.local.write('watch-store', stored);

    const listed = await run(WatchList.make());
    expect(listed.result?._tag === 'WatchListResult' && listed.result.storage.status).toBe(
      'unreadable'
    );
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
