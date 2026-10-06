import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UNATTENDED_DISCLOSURE } from '@gramgrab/protocol';
import { createExtensionHarness, type ExtensionHarness } from '../test/extension-harness.ts';
import { TARGET, createWatchInstagram } from '../test/watch-instagram.ts';
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

describe('Watches options page', () => {
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
