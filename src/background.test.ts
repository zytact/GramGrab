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

  // ── DOWNLOAD_MEDIA ────────────────────────────────────────────────────────
  // Happy-path, error, and partial-failure cases are covered by integration tests.
  // We keep the concurrency cap test here as it is not observable through the UI.

  describe('DOWNLOAD_MEDIA', () => {
    it('caps concurrent browser.downloads.download calls at 3', async () => {
      let inflight = 0;
      let maxInflight = 0;
      fakeBrowserObj.fakeBrowser.downloads.download.mockImplementation(() => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        return new Promise<number>(resolve =>
          setTimeout(() => {
            inflight--;
            resolve(1);
          }, 10)
        );
      });

      const listener = await loadBackground();
      await invoke(listener, {
        type: 'DOWNLOAD_MEDIA',
        urls: Array.from({ length: 10 }, (_, i) => `https://cdn.instagram.com/${i}.jpg`),
        hints: Array.from({ length: 10 }, (_, i) => `hint_${i}`),
        types: Array(10).fill('image') as string[],
      });

      expect(maxInflight).toBeLessThanOrEqual(3);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledTimes(10);
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

  // ── FETCH_MEDIA (profile) ─────────────────────────────────────────────────

  describe('FETCH_MEDIA — profile', () => {
    it('returns { media } with image item on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            user: {
              id: '999',
              profile_pic_url_hd: 'https://cdn.instagram.com/pic_hd.jpg',
              profile_pic_dimensions: { width: 320, height: 320 },
            },
          },
        }),
      }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/someuser/',
      })) as { media: { url: string; type: string }[]; error: undefined };

      expect(result.error).toBeUndefined();
      expect(result.media).toHaveLength(1);
      expect(result.media[0]?.url).toBe('https://cdn.instagram.com/pic_hd.jpg');
      expect(result.media[0]?.type).toBe('image');
    });

    it('returns { error } when profile fetch returns non-ok status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/someuser/',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('Profile request failed') });
    });
  });

  // ── DOWNLOAD ─────────────────────────────────────────────────────────────

  describe('DOWNLOAD', () => {
    it('downloads each resolved media item and returns them', async () => {
      const mockMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphImage',
            shortcode: 'dl123',
            display_url: 'https://cdn.instagram.com/dl.jpg',
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
        type: 'DOWNLOAD',
        url: 'https://www.instagram.com/p/dl123/',
      })) as { media: unknown[]; error: undefined };

      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.media)).toBe(true);
      expect(result.media.length).toBeGreaterThan(0);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledTimes(1);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://cdn.instagram.com/dl.jpg' })
      );
    });

    it('selects only the carouselIndex item when provided', async () => {
      const mockMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphSidecar',
            shortcode: 'side1',
            edge_sidecar_to_children: {
              edges: [
                {
                  node: {
                    display_url: 'https://cdn.instagram.com/slide1.jpg',
                    display_resources: [
                      { src: 'https://cdn.instagram.com/slide1_hq.jpg', config_width: 1080 },
                    ],
                  },
                },
                {
                  node: {
                    display_url: 'https://cdn.instagram.com/slide2.jpg',
                    display_resources: [
                      { src: 'https://cdn.instagram.com/slide2_hq.jpg', config_width: 1080 },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMedia,
      }) as unknown as typeof fetch;

      const listener = await loadBackground();
      await invoke(listener, {
        type: 'DOWNLOAD',
        url: 'https://www.instagram.com/p/side1/',
        carouselIndex: 1,
      });

      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledTimes(1);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://cdn.instagram.com/slide2_hq.jpg' })
      );
    });

    it('returns { error } when URL is unsupported', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD',
        url: 'https://www.google.com/',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('Invalid Instagram URL') });
    });

    it('returns { error } containing media-not-found hint when GraphQL returns no media', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}), // no media fields
      }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD',
        url: 'https://www.instagram.com/p/abc123/',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('No media found') });
    });

    it('returns { error } when all browser downloads fail', async () => {
      const mockMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphImage',
            shortcode: 'fail1',
            display_url: 'https://cdn.instagram.com/fail.jpg',
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMedia,
      }) as unknown as typeof fetch;
      fakeBrowserObj.fakeBrowser.downloads.download.mockRejectedValue(new Error('disk full'));

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'DOWNLOAD',
        url: 'https://www.instagram.com/p/fail1/',
      })) as { media: unknown; error: string; failures: { url: string; reason: string }[] };
      expect(result.error).toBe('All downloads failed');
      expect(result.media).toBeUndefined();
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('disk full');
    });

    it('returns partial success when some browser downloads fail (sidecar)', async () => {
      const mockMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphSidecar',
            shortcode: 'partial1',
            edge_sidecar_to_children: {
              edges: [
                {
                  node: {
                    display_url: 'https://cdn.instagram.com/s1.jpg',
                    display_resources: [
                      { src: 'https://cdn.instagram.com/s1.jpg', config_width: 1080 },
                    ],
                  },
                },
                {
                  node: {
                    display_url: 'https://cdn.instagram.com/s2.jpg',
                    display_resources: [
                      { src: 'https://cdn.instagram.com/s2.jpg', config_width: 1080 },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMedia,
      }) as unknown as typeof fetch;

      let callCount = 0;
      fakeBrowserObj.fakeBrowser.downloads.download.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? Promise.reject(new Error('cdn error')) : Promise.resolve(1);
      });

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'DOWNLOAD',
        url: 'https://www.instagram.com/p/partial1/',
      })) as {
        media: unknown[];
        error: string | undefined;
        failures: { url: string; reason: string }[];
      };
      expect(result.error).toBeUndefined();
      expect(result.media).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.reason).toContain('cdn error');
    });

    it('caps concurrent browser.downloads.download calls at 3 (sidecar)', async () => {
      const edges = Array.from({ length: 10 }, (_, i) => ({
        node: {
          display_url: `https://cdn.instagram.com/s${i}.jpg`,
          display_resources: [{ src: `https://cdn.instagram.com/s${i}.jpg`, config_width: 1080 }],
        },
      }));
      const mockMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphSidecar',
            shortcode: 'concurrency1',
            edge_sidecar_to_children: { edges },
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockMedia,
      }) as unknown as typeof fetch;

      let inflight = 0;
      let maxInflight = 0;
      fakeBrowserObj.fakeBrowser.downloads.download.mockImplementation(() => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        return new Promise<number>(resolve =>
          setTimeout(() => {
            inflight--;
            resolve(1);
          }, 10)
        );
      });

      const listener = await loadBackground();
      await invoke(listener, {
        type: 'DOWNLOAD',
        url: 'https://www.instagram.com/p/concurrency1/',
      });

      expect(maxInflight).toBeLessThanOrEqual(3);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledTimes(10);
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
