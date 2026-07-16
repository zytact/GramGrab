/**
 * Integration tests: user drives the popup UI and we assert on real side-effects
 * (browser.downloads.download calls, rendered DOM). The background dispatcher runs
 * the actual message handlers — no stub at the message boundary except where we need
 * to avoid real network calls (FETCH_MEDIA stubs canned media; fetch() is mocked for
 * tests that route through the real graphql handler).
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Popup from './popup';
import {
  resetBrowserMocks,
  loadBackground,
  setMockMessageHandler,
  getDownloadCalls,
} from './test/setup.ts';

vi.mock('./styles.css', () => ({}));

const INSTAGRAM_URL = 'https://www.instagram.com/p/abc123/';

const CANNED_MEDIA = [
  { url: 'https://cdn.instagram.com/image.jpg', type: 'image', filenameHint: 'post_abc_image' },
  { url: 'https://cdn.instagram.com/video.mp4', type: 'video', filenameHint: 'post_abc_video' },
];

describe('integration: user-facing flows', () => {
  beforeEach(async () => {
    resetBrowserMocks();
    await loadBackground();
  });

  // ── Flow 1: Download selected media end-to-end ──────────────────────────────

  it('downloads all items when user fetches then clicks Download Selected', async () => {
    setMockMessageHandler('FETCH_MEDIA', () => ({ media: CANNED_MEDIA, error: undefined }));

    const user = userEvent.setup();
    render(<Popup />);

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(INSTAGRAM_URL);
    });

    await user.click(screen.getByText('Fetch Media'));

    await waitFor(() => {
      expect(screen.getByText(/2 items found/i)).toBeDefined();
    });

    await user.click(screen.getByText(/Download 2 Selected/i));

    await waitFor(() => {
      expect(getDownloadCalls()).toHaveLength(2);
    });

    const calls = getDownloadCalls();
    expect(calls[0]).toMatchObject({ url: CANNED_MEDIA[0]!.url, filename: 'post_abc_image_1.jpg' });
    expect(calls[1]).toMatchObject({ url: CANNED_MEDIA[1]!.url, filename: 'post_abc_video_2.mp4' });

    expect(screen.getByText(/2 items started/i)).toBeDefined();
  });

  // ── Flow 2: Fetch media from active tab URL ─────────────────────────────────

  it('auto-populates URL from active tab and renders media list after fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphImage',
            shortcode: 'abc123',
            display_url: 'https://cdn.instagram.com/image.jpg',
            taken_at_timestamp: 1700000000,
          },
        },
      }),
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<Popup />);

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(INSTAGRAM_URL);
    });

    expect(screen.getByText(/Instagram URL detected/i)).toBeDefined();

    await user.click(screen.getByText('Fetch Media'));

    await waitFor(() => {
      expect(screen.getByText(/1 item found/i)).toBeDefined();
    });
  });

  // ── Flow 3: Error path — invalid URL ────────────────────────────────────────

  it('shows error and triggers no downloads when background rejects the URL', async () => {
    const user = userEvent.setup();
    render(<Popup />);

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(INSTAGRAM_URL);
    });

    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'https://www.google.com/');

    await user.click(screen.getByText('Fetch Media'));

    await waitFor(() => {
      expect(screen.getAllByText(/Use an Instagram link/i)).toHaveLength(2);
    });

    expect(getDownloadCalls()).toHaveLength(0);
  });

  // ── Flow 4: Fallback preview — GET_PREVIEW_URL triggered on img error ───────

  it('fetches fallback preview URL when image fails to load and updates the img src', async () => {
    const PREVIEW_DATA_URL = 'data:image/png;base64,abc==';

    setMockMessageHandler('FETCH_MEDIA', () => ({
      media: [
        { url: 'https://cdn.instagram.com/image.jpg', type: 'image', filenameHint: 'post_abc' },
      ],
      error: undefined,
    }));

    // Background routes GET_PREVIEW_URL to real handler; mock fetch to return a blob
    const fakeBlob = new Blob(['PNG'], { type: 'image/png' });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => fakeBlob,
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<Popup />);

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(INSTAGRAM_URL);
    });

    await user.click(screen.getByText('Fetch Media'));

    await waitFor(() => {
      expect(screen.getByText(/1 item found/i)).toBeDefined();
    });

    const img = screen.getByAltText('Preview') as HTMLImageElement;
    fireEvent.error(img);

    await waitFor(() => {
      const updatedImg = screen.getByAltText('Preview') as HTMLImageElement;
      expect(updatedImg.src).toMatch(/^data:image\/png;base64,/);
    });

    void PREVIEW_DATA_URL; // suppress lint
  });
});
