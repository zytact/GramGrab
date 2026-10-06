import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNATTENDED_DISCLOSURE } from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, VIEWER, createWatchInstagram, restMedia } from '../test/watch-instagram.ts';
import { processingBrowser } from '../test/processing-browser.ts';
import type { MessageResponse } from '../messaging/contracts.ts';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      name: 'Select for download',
    });

    expect(instant).toHaveProperty('disabled', true);
    await user.click(story!);
    await user.click(screen.getByRole('button', { name: 'Download Original (1)' }));

    await waitFor(() => expect(screen.getAllByText(/Story expired/)).toHaveLength(2));
    expect(harness.downloads).toEqual([]);
  });

  it('uses the export inspector and retries its frozen Frame settings after the controls change', async () => {
    seedWatchWithProblemAndEntry([
      {
        id: '2d0a5f7e-4c6b-4d8e-9f3a-9b0c1d2e3f4a',
        checkId: '1c9f4e6d-3b5a-4f7c-8d2e-8a9b0c1d2e3f',
        ref: { _tag: 'Post', mediaId: '200', shortcode: 'C200', mediaType: 'video', takenAt: 2 },
        discoveredAt: Date.now() - 120_000,
        collect: { at: Date.now() - 120_000 },
      },
    ]);
    instagram.state.media.C200 = restMedia({ id: '200', video: true, takenAt: 2 });
    const { seek } = await processingBrowser(harness, instagram);
    const user = userEvent.setup();
    render(<Watches />);
    await user.click(await screen.findByText(/^All inbox$/));
    const [, video] = await screen.findAllByRole('checkbox', { name: 'Select for download' });
    await user.click(video!);
    await user.selectOptions(screen.getByLabelText('Export mode'), 'frame');
    const timestamp = screen.getByLabelText('Frame timestamp in seconds');
    await user.clear(timestamp);
    await user.click(screen.getByRole('button', { name: 'Download Frame (1)' }));
    expect(screen.getByText('Enter a frame timestamp of zero or more seconds.')).toBeDefined();
    expect(harness.downloads).toHaveLength(0);
    await user.type(timestamp, '8.5');
    harness.failDownloads(new Error('network failure'));
    await user.click(screen.getByRole('button', { name: 'Download Frame (1)' }));
    await screen.findByRole('button', { name: 'Retry failed exports' });
    await user.selectOptions(screen.getByLabelText('Export mode'), 'direct');
    harness.failDownloads(undefined);
    await user.click(screen.getByRole('button', { name: 'Retry failed exports' }));
    await waitFor(() => expect(harness.downloads).toHaveLength(1));
    const history = await harness.send<MessageResponse<'GET_DOWNLOAD_HISTORY'>>({
      type: 'GET_DOWNLOAD_HISTORY',
    });
    expect(history.entries).toMatchObject([{ exportMode: 'frame', frameTimestampSeconds: 8.5 }]);
    expect(seek.mock.calls.every(([second]) => second === 8.5)).toBe(true);
    expect(harness.browser.tabs.create).not.toHaveBeenCalled();
  });

  it('restricts Avatar selections to Original with no rotation', async () => {
    seedWatchWithProblemAndEntry([
      {
        id: '2d0a5f7e-4c6b-4d8e-9f3a-9b0c1d2e3f4a',
        checkId: '1c9f4e6d-3b5a-4f7c-8d2e-8a9b0c1d2e3f',
        ref: { _tag: 'Avatar', pictureId: 'PIC_B' },
        discoveredAt: Date.now() - 120_000,
        collect: { at: Date.now() - 120_000 },
      },
    ]);
    const user = userEvent.setup();
    render(<Watches />);
    await user.click(await screen.findByText(/^All inbox$/));
    const [story, avatar] = await screen.findAllByRole('checkbox', { name: 'Select for download' });
    await user.click(story!);
    await user.selectOptions(screen.getByLabelText('Export mode'), 'frame');
    await user.selectOptions(screen.getByLabelText('Export rotation'), '90');
    await user.click(avatar!);
    expect(screen.getByLabelText('Export mode')).toHaveProperty('value', 'direct');
    expect(screen.getByLabelText('Export rotation')).toHaveProperty('value', '0');
    expect(screen.getByLabelText('Export rotation')).toHaveProperty('disabled', true);
    expect(screen.getByRole('option', { name: 'Frame at a timestamp' })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('offers confirmation for uncertain files and dismissal for final download failures', async () => {
    const now = Date.now();
    seedWatchWithProblemAndEntry([
      {
        id: '2d0a5f7e-4c6b-4d8e-9f3a-9b0c1d2e3f4a',
        checkId: '1c9f4e6d-3b5a-4f7c-8d2e-8a9b0c1d2e3f',
        ref: {
          _tag: 'Sidecar',
          mediaId: '80',
          shortcode: 'C80',
          takenAt: 2,
          children: [
            { mediaId: '81', mediaType: 'image' },
            { mediaId: '82', mediaType: 'video' },
          ],
        },
        discoveredAt: now,
        download: {
          children: [
            { status: 'uncertain', at: now },
            { status: 'failed', code: 'WATCH_MEDIA_UNAVAILABLE', at: now },
          ],
          dismissed: false,
        },
        missingChildren: ['82'],
      },
    ]);
    const user = userEvent.setup();
    render(<Watches />);
    await screen.findByRole('button', { name: 'I have the file' });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(harness.badge).toBe('3');
    await user.click(screen.getByRole('button', { name: 'I have the file' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'I have the file' })).toBeNull()
    );
    expect(harness.badge).toBe('2');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull());
    expect(harness.badge).toBe('1');
    expect(harness.downloads).toEqual([]);
    expect(harness.local.read('download-history')).toBeUndefined();
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
    expect(harness.local.read('watch-store')).toMatchObject({
      watches: [{ targetId: TARGET.id, kinds: ['posts', 'stories'] }],
    });
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
