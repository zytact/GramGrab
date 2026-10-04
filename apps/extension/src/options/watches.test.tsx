import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNATTENDED_DISCLOSURE } from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, VIEWER, createWatchInstagram } from '../test/watch-instagram.ts';
import { Watches } from './watches.tsx';

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

async function addWatch(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText('+ Add Watch'));
  await user.type(screen.getByPlaceholderText(/username or instagram.com/), TARGET.username);
  await user.click(screen.getByText('Find account'));
  await screen.findByText(/Followed by account ID|You already watch this account/);
}

/** A stored Watch whose Stories check failed and which collected one Story. */
function seedWatchWithProblemAndEntry(extra: readonly object[] = []) {
  const now = Date.now();
  harness.local.write('watch-store', {
    version: 1,
    watches: [
      {
        id: '6f1b2a9e-7c3d-4b8a-9e1f-2a3b4c5d6e7f',
        viewerId: VIEWER.id,
        targetId: TARGET.id,
        username: TARGET.username,
        createdAt: now - 60_000,
        enabled: true,
        kinds: ['stories'],
        actions: ['collect'],
        tracking: {
          stories: {
            baselineCutoff: 1,
            lastSuccessAt: now - 60_000,
            lastCheckAt: now,
            problem: { code: 'IG_RESPONSE_SHAPE_UNKNOWN', at: now },
          },
        },
        discoveries: [
          {
            id: '0b8e3d5c-2a4f-4e6b-9c1d-7f8a9b0c1d2e',
            checkId: '1c9f4e6d-3b5a-4f7c-8d2e-8a9b0c1d2e3f',
            ref: { _tag: 'Story', mediaId: '31', mediaType: 'video', takenAt: 2, expiresAt: 3 },
            discoveredAt: now - 60_000,
            collect: { at: now - 60_000 },
          },
          ...extra,
        ],
      },
    ],
  });
}

describe('Watches options page', () => {
  it('opens on Needs you while a check problem needs attention, and lists collected entries', async () => {
    seedWatchWithProblemAndEntry();
    const user = userEvent.setup();
    render(<Watches />);

    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeDefined();
    expect(screen.getByText(/Instagram's format has changed/)).toBeDefined();
    await user.click(screen.getByText(/^All inbox$/));
    expect(await screen.findByText(`@${TARGET.username} · Video`)).toBeDefined();
    expect(screen.getByText(/leaves the inbox in 30 days/)).toBeDefined();
  });

  it('downloads selected inbox entries as Original but never selects an unavailable one', async () => {
    seedWatchWithProblemAndEntry([
      {
        id: '2d0a5f7e-4c6b-4d8e-9f3a-9b0c1d2e3f4a',
        checkId: '1c9f4e6d-3b5a-4f7c-8d2e-8a9b0c1d2e3f',
        ref: { _tag: 'Instant', mediaId: '41_2002', mediaType: 'image', takenAt: 2 },
        discoveredAt: Date.now() - 120_000,
        unavailable: 'WATCH_INSTANT_NOT_IN_FEED',
        collect: { at: Date.now() - 120_000 },
      },
    ]);
    const user = userEvent.setup();
    render(<Watches />);
    await user.click(await screen.findByText(/^All inbox$/));
    const [story, instant] = await screen.findAllByRole('checkbox', {
      name: 'Select for Download Original',
    });

    expect(instant).toHaveProperty('disabled', true);
    await user.click(story!);
    await user.click(screen.getByRole('button', { name: 'Download Original (1)' }));

    await waitFor(() => expect(screen.getAllByText(/Story expired/)).toHaveLength(2));
    expect(harness.downloads).toEqual([]);
  });

  it('adds a Watch only after the settled disclosure is acknowledged', async () => {
    const user = userEvent.setup();
    render(<Watches />);
    await addWatch(user);

    const add = screen.getByRole('button', { name: 'Add Watch' });
    expect(add).toHaveProperty('disabled', true);
    await user.click(screen.getByText(UNATTENDED_DISCLOSURE));
    await user.click(add);

    await screen.findAllByText(/First check pending/);
    expect(screen.getByText('Pause checks')).toBeDefined();
    expect(harness.local.read('watch-store')).toMatchObject({ watches: [{ targetId: TARGET.id }] });
  });

  it('opens the existing Watch instead of adding a duplicate', async () => {
    const user = userEvent.setup();
    render(<Watches />);
    await addWatch(user);
    await user.click(screen.getByText(UNATTENDED_DISCLOSURE));
    await user.click(screen.getByRole('button', { name: 'Add Watch' }));
    await screen.findByText('Pause checks');

    await addWatch(user);
    await user.click(await screen.findByText('Open its Watch'));

    expect(await screen.findByText('Pause checks')).toBeDefined();
    expect(harness.local.read('watch-store')).toMatchObject({ watches: [{}] });
  });

  it('shows only sign-in guidance and the stored count without a verified login', async () => {
    harness.local.write('watch-store', { version: 1, watches: [] });
    instagram.state.viewer = null;
    render(<Watches />);

    expect(await screen.findByText('Sign in to Instagram')).toBeDefined();
    expect(screen.getByText('0 Watches stored in this browser.')).toBeDefined();
    expect(screen.queryByText('+ Add Watch')).toBeNull();
  });

  it('stops with a red storage banner when the store cannot be read', async () => {
    harness.local.write('watch-store', { version: 1, watches: [{ id: 'broken' }] });
    render(<Watches />);

    await waitFor(() => expect(screen.getByText('Watches stopped.')).toBeDefined());
    expect(screen.getByText(/Saved Watch data was not dropped or reset/)).toBeDefined();
  });
});
