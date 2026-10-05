import { Schema } from 'effect';
import { afterEach, expect, it } from 'vite-plus/test';
import {
  AccountIdSelector,
  WatchAdd,
  WatchLifecycle,
  WatchList,
  type WatchCommand,
} from '@gramgrab/protocol';
import { createExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, VIEWER, avatarSearch, createWatchInstagram } from '../test/watch-instagram.ts';
import type { WatchCommandResponse } from '../messaging/contracts.ts';
import { STORE_BUDGET_BYTES, WatchStore, type Discovery } from './contracts.ts';

const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;
afterEach(() => {
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

it('enforces the aggregate byte budget without eviction and recovers after explicit deletion', async () => {
  const harness = createExtensionHarness();
  const instagram = createWatchInstagram();
  harness.setFetch(instagram.handle);
  await harness.loadWorker();
  const run = (command: WatchCommand) =>
    harness.send<WatchCommandResponse>({ type: 'WATCH_COMMAND', command });
  const add = (target: string) =>
    run(WatchAdd.make({ target, kinds: ['posts'], actions: ['collect'], acceptUnattended: true }));
  await add(TARGET.username);
  const first = Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches[0]!;
  const second = {
    ...first,
    id: '00000000-0000-4000-8000-000000000001',
    viewerId: '1002',
    targetId: '2003',
    username: 'instagram',
  };
  const empty = { version: 1, watches: [first, second] } as const;
  const discovery: Discovery = {
    id: '00000000-0000-4000-8000-000000000002',
    checkId: '00000000-0000-4000-8000-000000000003',
    ref: { _tag: 'Avatar', pictureId: 'p' },
    discoveredAt: Date.now(),
    collect: { at: Date.now() },
  };
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const count = Math.floor((STORE_BUDGET_BYTES - size(empty)) / (size(discovery) + 1));
  const entries = Array.from({ length: count }, (_, index) => ({
    ...discovery,
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
  }));
  const split = Math.floor(entries.length / 2);
  const filled = {
    version: 1,
    watches: [
      { ...first, discoveries: entries.slice(0, split) },
      { ...second, discoveries: entries.slice(split) },
    ],
  };
  const room = STORE_BUDGET_BYTES - size(filled);
  filled.watches[0]!.discoveries[0]!.ref = {
    _tag: 'Avatar',
    pictureId: 'p'.repeat(1 + Math.min(room - 1, 127)),
  };
  const encoded = Schema.encodeSync(WatchStore)(Schema.decodeUnknownSync(WatchStore)(filled));
  expect(size(encoded)).toBeLessThanOrEqual(STORE_BUDGET_BYTES);
  expect(STORE_BUDGET_BYTES - size(encoded)).toBeLessThan(100);
  expect(encoded.watches.every(watch => size(watch) < STORE_BUDGET_BYTES)).toBe(true);
  harness.local.write('watch-store', encoded);
  instagram.state.accounts.instagram = { id: '3003' };
  instagram.state.profile = { data: { user: { id: '3003', username: 'instagram' } } };
  instagram.state.search = avatarSearch({ id: '3003', username: 'instagram' });
  const refused = await add('instagram');
  expect(refused.failure?._tag === 'CommandFailure' && refused.failure.failure.code).toBe(
    'WATCH_STORE_CAPACITY_EXCEEDED'
  );
  expect(harness.local.read('watch-store')).toEqual(encoded);
  expect(harness.downloads).toHaveLength(0);
  expect(harness.notifications.size).toBe(0);
  await run(
    WatchLifecycle.make({
      operation: 'delete',
      watches: [AccountIdSelector.make({ accountId: TARGET.id })],
    })
  );
  expect((await add('instagram')).result?._tag).toBe('WatchAddResult');
  const listed = await run(WatchList.make());
  expect(listed.result?._tag === 'WatchListResult' && listed.result.storage.status).toBe('ok');
  expect(
    Schema.decodeUnknownSync(WatchStore)(harness.local.read('watch-store')).watches.find(
      watch => watch.viewerId !== VIEWER.id
    )
  ).toEqual(encoded.watches[1]);
}, 20_000);
