/**
 * Unit tests for the background message dispatcher.
 *
 * Strategy: install a fake `browser` global with spy stubs, then dynamically
 * import background.ts (which registers the listener synchronously), capture
 * the registered listener, and invoke it directly with test messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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
  let contextClickListener:
    | ((
        info: { menuItemId: string; pageUrl?: string; linkUrl?: string; srcUrl?: string },
        tab?: { url?: string }
      ) => void)
    | null = null;

  const fakeBrowser = {
    runtime: {
      getURL: vi.fn().mockImplementation((path: string) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn((cb: Listener) => {
          registeredListener = cb;
        }),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    downloads: { download: vi.fn().mockResolvedValue(1) },
    storage: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    windows: { update: vi.fn().mockResolvedValue(undefined) },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn().mockResolvedValue(undefined),
      onClicked: { addListener: vi.fn(callback => (contextClickListener = callback)) },
    },
  };

  return {
    fakeBrowser,
    getListener: () => registeredListener,
    getContextClickListener: () => contextClickListener,
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

  it('registers an idempotent GramGrab submenu and routes link commands', async () => {
    await import('./background');
    await Promise.resolve();
    expect(fakeBrowserObj.fakeBrowser.contextMenus.create).toHaveBeenCalledTimes(3);
    expect(fakeBrowserObj.fakeBrowser.contextMenus.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'gramgrab',
        contexts: ['page', 'link', 'image', 'video'],
        documentUrlPatterns: ['https://*.instagram.com/*'],
      })
    );
    const click = fakeBrowserObj.getContextClickListener()!;
    click({
      menuItemId: 'gramgrab-fetch',
      pageUrl: 'https://elsewhere.example/',
      linkUrl: 'http://instagram.com/stories/person/123/',
    });
    await vi.waitFor(() => {
      expect(fakeBrowserObj.fakeBrowser.storage.set).toHaveBeenCalledWith({
        'workspace-transfer-v1': expect.objectContaining({
          url: 'https://www.instagram.com/stories/person/',
          intent: 'fetch',
        }),
      });
      expect(fakeBrowserObj.fakeBrowser.tabs.create).toHaveBeenCalledWith({
        active: true,
        url: expect.stringContaining('popup.html?surface=workspace&source='),
      });
    });
  });

  it('uses the clicked tab URL when Chromium omits page and link URLs', async () => {
    await import('./background');
    await Promise.resolve();
    const click = fakeBrowserObj.getContextClickListener()!;
    click({ menuItemId: 'gramgrab-open' }, { url: 'https://www.instagram.com/reel/example-reel/' });

    await vi.waitFor(() => {
      expect(fakeBrowserObj.fakeBrowser.storage.set).toHaveBeenCalledWith({
        'workspace-transfer-v1': expect.objectContaining({
          url: 'https://www.instagram.com/reel/example-reel/',
          intent: 'open',
        }),
      });
    });
  });

  it('falls back to the page URL when the clicked link is not a supported target', async () => {
    await import('./background');
    await Promise.resolve();
    const click = fakeBrowserObj.getContextClickListener()!;
    click({
      menuItemId: 'gramgrab-fetch',
      linkUrl: 'https://help.instagram.com/',
      pageUrl: 'https://www.instagram.com/p/page-shortcode/',
    });

    await vi.waitFor(() => {
      expect(fakeBrowserObj.fakeBrowser.storage.set).toHaveBeenCalledWith({
        'workspace-transfer-v1': expect.objectContaining({
          url: 'https://www.instagram.com/p/page-shortcode/',
          intent: 'fetch',
        }),
      });
    });
  });

  it('opens the workspace with an explanation for unsupported Instagram routes', async () => {
    await import('./background');
    const click = fakeBrowserObj.getContextClickListener()!;
    click({
      menuItemId: 'gramgrab-fetch',
      pageUrl: 'https://www.instagram.com/explore/',
    });

    await vi.waitFor(() => {
      expect(fakeBrowserObj.fakeBrowser.storage.set).toHaveBeenCalledWith({
        'workspace-transfer-v1': expect.objectContaining({
          url: 'https://www.instagram.com/explore/',
          fetchedUrl: 'https://www.instagram.com/explore/',
          status: 'error',
          message: expect.stringContaining('not supported'),
        }),
      });
      expect(fakeBrowserObj.fakeBrowser.tabs.create).toHaveBeenCalledWith({
        active: true,
        url: expect.stringContaining('popup.html?surface=workspace&source='),
      });
    });
  });

  it('uses the page URL for image and video context commands', async () => {
    await import('./background');
    await Promise.resolve();
    const click = fakeBrowserObj.getContextClickListener()!;
    click({
      menuItemId: 'gramgrab-open',
      pageUrl: 'https://www.instagram.com/reel/media-shortcode/',
      srcUrl: 'https://instagram.example-cdn.test/media.jpg',
    });

    await vi.waitFor(() => {
      expect(fakeBrowserObj.fakeBrowser.tabs.create).toHaveBeenCalledWith({
        active: true,
        url: expect.stringContaining('popup.html?surface=workspace&source='),
      });
    });
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

  // ── FETCH_MEDIA (shortcode fallback) ─────────────────────────────────────

  describe('FETCH_MEDIA — shortcode fallback', () => {
    it('falls back to /api/graphql/ POST when the old shortcode route has no node', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      const fallbackMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphImage',
            shortcode: 'fallback1',
            display_url: 'https://cdn.instagram.com/fallback.jpg',
          },
        },
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => fallbackMedia,
        }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/fallback1/',
      })) as {
        media: { url: string; type: string; filenameHint: string; previewUrl?: string }[];
        error: undefined;
      };

      expect(result.error).toBeUndefined();
      expect(result.media).toHaveLength(1);
      expect(result.media[0]?.url).toBe('https://cdn.instagram.com/fallback.jpg');
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        'https://www.instagram.com/api/graphql/',
        expect.objectContaining({ method: 'POST', body: expect.any(URLSearchParams) })
      );
    });

    it('falls back to /api/graphql/ POST when the old shortcode route is non-json', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      const fallbackMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphVideo',
            shortcode: 'fallback2',
            video_url: 'https://cdn.instagram.com/fallback.mp4',
            display_url: 'https://cdn.instagram.com/fallback.jpg',
          },
        },
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => fallbackMedia,
        }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/reel/fallback2/',
      })) as {
        media: { url: string; type: string; filenameHint: string; previewUrl?: string }[];
        error: undefined;
      };

      expect(result.error).toBeUndefined();
      expect(result.media[0]?.type).toBe('video');
      expect(result.media[0]?.url).toBe('https://cdn.instagram.com/fallback.mp4');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        'https://www.instagram.com/api/graphql/',
        expect.objectContaining({ method: 'POST', body: expect.any(URLSearchParams) })
      );
    });

    it('tries the newer shortcode doc id when the older doc id returns no media', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      const fallbackMedia = {
        data: {
          xdt_shortcode_media: {
            __typename: 'XDTGraphSidecar',
            shortcode: 'newdoc1',
            edge_sidecar_to_children: {
              edges: [
                {
                  node: {
                    __typename: 'XDTGraphImage',
                    shortcode: 'newdoc1child',
                    display_url: 'https://cdn.instagram.com/newdoc.jpg',
                  },
                },
              ],
            },
          },
        },
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => fallbackMedia,
        }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/newdoc1/',
      })) as {
        media: { url: string; type: string; filenameHint: string; previewUrl?: string }[];
        error: undefined;
      };

      expect(result.error).toBeUndefined();
      expect(result.media[0]?.url).toBe('https://cdn.instagram.com/newdoc.jpg');
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      expect(
        String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])
      ).toContain('doc_id=10015901848480474');
    });

    it('surfaces POST failure when every shortcode doc id GET is empty', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
        }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/forbidden1/',
      })) as { media: undefined; error: string };

      expect(result.media).toBeUndefined();
      expect(result.error).toBe('GraphQL failed: 403');
      expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    });

    it('surfaces malformed shortcode responses when every fallback is empty', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: {}, errors: [{ message: 'not found' }] }),
        }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/broken1/',
      })) as { media: undefined; error: string };

      expect(result.media).toBeUndefined();
      expect(result.error).toContain('Instagram changed their response format');
      expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    });

    it('surfaces known shortcode nodes that have no usable media url', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            xdt_shortcode_media: {
              __typename: 'XDTGraphImage',
              shortcode: 'emptyimage1',
            },
          },
        }),
      }) as unknown as typeof fetch;

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/emptyimage1/',
      })) as { media: undefined; error: string };

      expect(result.media).toBeUndefined();
      expect(result.error).toContain('Instagram changed their response format');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
    function toFetchUrl(input: RequestInfo | URL): string {
      if (typeof input === 'string') return input;
      return input instanceof URL ? input.toString() : input.url;
    }

    function mockJsonResponse(body: unknown, ok = true, status = 200, statusText = 'OK') {
      return {
        ok,
        status,
        statusText,
        json: async () => body,
      };
    }

    function classifyProfileFetchUrl(url: string) {
      if (url.includes('/api/v1/users/web_profile_info/')) return 'web-profile';
      if (url.includes('/highlights_tray/')) return 'tray';
      if (url.includes('/users/') && url.includes('/info/')) return 'user-info';
      return 'default';
    }

    function buildWebProfileResponse(opts: {
      webProfile?: unknown;
      webProfileOk?: boolean;
      webProfileStatus?: number;
    }) {
      return mockJsonResponse(
        opts.webProfile ?? {},
        opts.webProfileOk ?? true,
        opts.webProfileStatus ?? 200,
        'Not Found'
      );
    }

    function buildHighlightsTrayResponse(opts: {
      tray?: unknown;
      trayOk?: boolean;
      trayStatus?: number;
    }) {
      return mockJsonResponse(
        opts.tray ?? { tray: [] },
        opts.trayOk ?? true,
        opts.trayStatus ?? 200,
        'Forbidden'
      );
    }

    function buildUserInfoResponse(opts: { userInfoOk?: boolean }) {
      return mockJsonResponse({}, opts.userInfoOk ?? false, 200, 'OK');
    }

    function resolveProfileFetchResponse(
      url: string,
      opts: {
        webProfile?: unknown;
        webProfileOk?: boolean;
        webProfileStatus?: number;
        tray?: unknown;
        trayOk?: boolean;
        trayStatus?: number;
        userInfoOk?: boolean;
      }
    ) {
      switch (classifyProfileFetchUrl(url)) {
        case 'web-profile':
          return buildWebProfileResponse(opts);
        case 'tray':
          return buildHighlightsTrayResponse(opts);
        case 'user-info':
          return buildUserInfoResponse(opts);
        default:
          return mockJsonResponse({}, true, 200, 'OK');
      }
    }

    function mockProfileFetch(opts: {
      webProfile?: unknown;
      webProfileOk?: boolean;
      webProfileStatus?: number;
      tray?: unknown;
      trayOk?: boolean;
      trayStatus?: number;
      userInfoOk?: boolean;
    }) {
      globalThis.fetch = vi
        .fn()
        .mockImplementation(async (input: RequestInfo | URL) =>
          resolveProfileFetchResponse(toFetchUrl(input), opts)
        ) as unknown as typeof fetch;
    }

    it('returns avatar + highlight covers in one response', async () => {
      mockProfileFetch({
        webProfile: {
          data: {
            user: {
              id: '999',
              profile_pic_url_hd: 'https://cdn.instagram.com/pic_hd.jpg',
              profile_pic_dimensions: { width: 320, height: 320 },
            },
          },
        },
        tray: {
          tray: [
            {
              id: 'highlight:17900123',
              title: 'Travel',
              cover_media: {
                full_image_version: {
                  url: 'https://cdn.instagram.com/full1.jpg',
                  width: 1080,
                  height: 1920,
                },
                cropped_image_version: {
                  url: 'https://cdn.instagram.com/crop1.jpg',
                  width: 1080,
                  height: 1080,
                },
              },
            },
            {
              id: 17900456,
              cover_media: {
                cropped_image_version: { url: 'https://cdn.instagram.com/crop2.jpg' },
              },
            },
          ],
        },
      });

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/someuser/',
      })) as {
        media: { url: string; type: string; filenameHint: string; previewUrl?: string }[];
        error: undefined;
      };

      expect(result.error).toBeUndefined();
      expect(result.media).toHaveLength(3);
      expect(result.media[0]?.url).toBe('https://cdn.instagram.com/pic_hd.jpg');
      expect(result.media[0]).toMatchObject({ width: 320, height: 320 });
      expect(result.media[1]?.url).toBe('https://cdn.instagram.com/full1.jpg');
      expect(result.media[1]?.previewUrl).toBe('https://cdn.instagram.com/crop1.jpg');
      expect(result.media[1]).toMatchObject({ width: 1080, height: 1080 });
      expect(result.media[1]?.filenameHint).toBe('someuser_highlight_travel_17900123');
      expect(result.media[2]?.url).toBe('https://cdn.instagram.com/crop2.jpg');
      expect(result.media[2]?.previewUrl).toBeUndefined();
      expect(result.media[2]?.filenameHint).toBe('someuser_highlight_untitled_17900456');
    });

    it('still returns avatar when highlights_tray fetch fails (swallowed)', async () => {
      mockProfileFetch({
        webProfile: {
          data: {
            user: {
              id: '999',
              profile_pic_url_hd: 'https://cdn.instagram.com/pic_hd.jpg',
            },
          },
        },
        trayOk: false,
        trayStatus: 403,
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/someuser/',
      })) as { media: { url: string }[]; error: undefined };

      expect(result.error).toBeUndefined();
      expect(result.media).toHaveLength(1);
      expect(result.media[0]?.url).toBe('https://cdn.instagram.com/pic_hd.jpg');
      expect(warnSpy).toHaveBeenCalledWith('highlights_tray failed:', expect.anything());
      warnSpy.mockRestore();
    });

    it('returns { error } when profile fetch returns non-ok status', async () => {
      mockProfileFetch({ webProfileOk: false, webProfileStatus: 404 });

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
