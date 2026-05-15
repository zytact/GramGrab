/**
 * Unit tests for the background message dispatcher.
 *
 * Strategy: install a fake `browser` global with spy stubs, then dynamically
 * import background.ts (which registers the listener synchronously), capture
 * the registered listener, and invoke it directly with test messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Listener = (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean | void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeBrowser() {
  let registeredListener: Listener | null = null;

  const fakeBrowser = {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn((cb: Listener) => {
          registeredListener = cb;
        }),
      },
    },
    tabs: { query: vi.fn().mockResolvedValue([]) },
    downloads: { download: vi.fn().mockResolvedValue(1) },
    storage: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  };

  return {
    fakeBrowser,
    getListener: () => registeredListener,
  };
}

/** Invoke a listener and collect the response via sendResponse. */
function invoke(listener: Listener, msg: unknown): Promise<unknown> {
  return new Promise(resolve => {
    const ret = listener(msg, {}, resolve);
    // If the listener returns false/undefined (unknown type), resolve immediately
    if (!ret) resolve(undefined);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('background dispatcher', () => {
  let savedBrowser: typeof globalThis.browser;
  let savedFetch: typeof globalThis.fetch;
  let fakeBrowserObj: ReturnType<typeof makeFakeBrowser>;

  beforeEach(() => {
    savedBrowser = globalThis.browser;
    savedFetch = globalThis.fetch;
    vi.resetModules();

    fakeBrowserObj = makeFakeBrowser();
    globalThis.browser = fakeBrowserObj.fakeBrowser;
    globalThis.chrome = undefined;

    // Provide a default no-op fetch so graphqlFetch doesn't throw on tests
    // that don't mock fetch themselves (e.g. tests that expect parse errors).
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      blob: async () => new Blob([], { type: 'application/octet-stream' }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.browser = savedBrowser;
    globalThis.fetch = savedFetch;
    vi.resetModules();
  });

  async function loadBackground() {
    await import('./background');
    return fakeBrowserObj.getListener()!;
  }

  // ── Listener registration ─────────────────────────────────────────────────

  it('registers exactly one onMessage listener synchronously', async () => {
    await import('./background');
    expect(fakeBrowserObj.fakeBrowser.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it('returns true for known message types (indicates async sendResponse)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    }) as unknown as typeof fetch;
    const listener = await loadBackground();
    const sendResponse = vi.fn();

    const ret = listener(
      { type: 'FETCH_MEDIA', url: 'https://www.instagram.com/p/abc123/' },
      {},
      sendResponse
    );
    expect(ret).toBe(true);
  });

  it('returns false for unknown message types', async () => {
    const listener = await loadBackground();
    const sendResponse = vi.fn();
    const ret = listener({ type: 'UNKNOWN_TYPE' }, {}, sendResponse);
    expect(ret).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  // ── FETCH_MEDIA ───────────────────────────────────────────────────────────

  describe('FETCH_MEDIA', () => {
    it('returns { error } on unsupported URL', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.google.com/',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('Unsupported') });
    });

    it('returns { error } when fetch fails', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('network error')) as unknown as typeof fetch;
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/abc123/',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('network error') });
    });

    it('returns { media } on successful GraphQL response', async () => {
      const mockMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphImage',
            shortcode: 'abc123',
            display_url: 'https://cdn.instagram.com/image.jpg',
            taken_at_timestamp: 1700000000,
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMedia,
      }) as unknown as typeof fetch;
      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/abc123/',
      })) as { media: unknown[]; error: undefined };

      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.media)).toBe(true);
      expect(result.media.length).toBeGreaterThan(0);
    });
  });

  // ── GET_PREVIEW_URL ───────────────────────────────────────────────────────

  describe('GET_PREVIEW_URL', () => {
    it('returns { error } when the media fetch fails with non-ok status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        blob: async () => new Blob(),
      }) as unknown as typeof fetch;
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'GET_PREVIEW_URL',
        url: 'https://cdn.instagram.com/image.jpg',
      });
      expect(result).toMatchObject({ previewUrl: undefined, error: 'HTTP 403' });
    });

    it('returns a base64 data URL on success', async () => {
      const fakeBlob = new Blob(['PNG'], { type: 'image/png' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => fakeBlob,
      }) as unknown as typeof fetch;
      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'GET_PREVIEW_URL',
        url: 'https://cdn.instagram.com/image.jpg',
      })) as { previewUrl: string; error: undefined };

      expect(result.error).toBeUndefined();
      expect(result.previewUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('does not use FileReader (service-worker-safe)', async () => {
      const FileReaderSpy = vi.fn();
      globalThis.FileReader = FileReaderSpy as unknown as typeof FileReader;

      const fakeBlob = new Blob(['data'], { type: 'image/jpeg' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        blob: async () => fakeBlob,
      }) as unknown as typeof fetch;
      const listener = await loadBackground();
      await invoke(listener, {
        type: 'GET_PREVIEW_URL',
        url: 'https://cdn.instagram.com/image.jpg',
      });

      expect(FileReaderSpy).not.toHaveBeenCalled();
    });
  });

  // ── DOWNLOAD_MEDIA ────────────────────────────────────────────────────────

  describe('DOWNLOAD_MEDIA', () => {
    it('calls browser.downloads.download for each item', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD_MEDIA',
        urls: ['https://cdn.instagram.com/a.jpg', 'https://cdn.instagram.com/b.mp4'],
        hints: ['post_abc_image', 'post_abc_video'],
        types: ['image', 'video'],
      });

      expect(result).toEqual({ error: undefined });
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledTimes(2);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://cdn.instagram.com/a.jpg',
          filename: 'post_abc_image_1.jpg',
        })
      );
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://cdn.instagram.com/b.mp4',
          filename: 'post_abc_video_2.mp4',
        })
      );
    });

    it('returns { error } when downloads.download rejects', async () => {
      fakeBrowserObj.fakeBrowser.downloads.download.mockRejectedValue(new Error('disk full'));
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD_MEDIA',
        urls: ['https://cdn.instagram.com/a.jpg'],
        hints: ['hint'],
        types: ['image'],
      });
      expect(result).toMatchObject({ error: expect.stringContaining('disk full') });
    });
  });

  // ── DOWNLOAD_DEBUG_JSON ───────────────────────────────────────────────────

  describe('DOWNLOAD_DEBUG_JSON', () => {
    it('returns { error } when no json payload provided', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, { type: 'DOWNLOAD_DEBUG_JSON' });
      expect(result).toMatchObject({ error: 'No debug JSON available' });
    });

    it('downloads a data: URL (no URL.createObjectURL)', async () => {
      // We verify the download is called with a data: URL — jsonToDataUrl never
      // calls URL.createObjectURL, so we just check the argument shape.
      const listener = await loadBackground();
      await invoke(listener, { type: 'DOWNLOAD_DEBUG_JSON', json: { debug: true } });

      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringMatching(/^data:application\/json;base64,/),
        })
      );
    });
  });

  // ── DEBUG_SHAPE ───────────────────────────────────────────────────────────

  describe('DEBUG_SHAPE', () => {
    it('returns { error } for non-post/reel URLs', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DEBUG_SHAPE',
        url: 'https://www.instagram.com/stories/someuser/',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('post or reel') });
    });

    it('returns { raw } on successful fetch', async () => {
      const mockRaw = { data: { xdt_shortcode_media: { id: '123' } } };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockRaw,
      }) as unknown as typeof fetch;
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DEBUG_SHAPE',
        url: 'https://www.instagram.com/p/abc123/',
      });
      expect(result).toMatchObject({ raw: mockRaw });
    });
  });
});
