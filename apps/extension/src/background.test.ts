/**
 * Unit tests for the background message dispatcher.
 *
 * Strategy: install a fake `browser` global with spy stubs, then dynamically
 * import background.ts (which registers the listener synchronously), capture
 * the registered listener, and invoke it directly with test messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { Schema } from 'effect';
import {
  DirectExport,
  Export,
  ExportOperation,
  FrameExport,
  HumanItemNumber,
  InstantsExport,
  InternalItemIndex,
  MediaIdentity,
  OperationId,
  PROTOCOL_VERSION,
  Request,
} from '@gramgrab/protocol';
import { protocolConfig } from './instagram-protocol/config.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  let nativeMessageListener: ((message: unknown) => void) | null = null;
  let startupListener: (() => void) | null = null;
  const nativeMessages: unknown[] = [];
  let contextClickListener:
    | ((info: { menuItemId: string; pageUrl?: string; linkUrl?: string }) => void)
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
      onStartup: {
        addListener: vi.fn((listener: () => void) => {
          startupListener = listener;
        }),
      },
      connectNative: vi.fn(() => ({
        postMessage: (message: unknown) => nativeMessages.push(message),
        onMessage: {
          addListener: (listener: (message: unknown) => void) => {
            nativeMessageListener = listener;
          },
        },
        onDisconnect: { addListener: vi.fn() },
      })),
      getManifest: vi.fn(() => ({ version: 'test' })),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    downloads: {
      download: vi.fn().mockResolvedValue(1),
      search: vi.fn().mockResolvedValue([{ id: 1, state: 'complete', fileSize: 100 }]),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    cookies: {
      get: vi.fn().mockResolvedValue({ value: 'current-csrf-token' }),
    },
    storage: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    sessionStorage: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    windows: {
      create: vi.fn().mockResolvedValue({ id: 2, tabs: [{ id: 1 }] }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    contextMenus: {
      create: vi.fn(),
      removeAll: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      onClicked: { addListener: vi.fn(callback => (contextClickListener = callback)) },
      onShown: { addListener: vi.fn() },
    },
  };

  return {
    fakeBrowser,
    getListener: () => registeredListener,
    getStartupListener: () => startupListener,
    getNativeMessageListener: () => nativeMessageListener,
    nativeMessages,
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

const configuredShortcodeRequests = protocolConfig.operations.mediaByShortcode.candidates.flatMap(
  candidate => candidate.requests.map(request => ({ candidate, request }))
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function instantFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'apps/extension/src/effect/__fixtures__', name), 'utf8')
  );
}

function missingShortcodeResponse(): Response {
  return jsonResponse({ data: {}, errors: [{ message: 'not found' }] });
}

function fetchMock(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): typeof fetch {
  return Object.assign(vi.fn(implementation), { preconnect: vi.fn() });
}

function installFetchSequence(responses: readonly Response[]): void {
  let index = 0;
  globalThis.fetch = fetchMock(async () => {
    const response = responses[index++];
    if (!response) throw new Error('Unexpected extra configured GraphQL request');
    return response;
  });
}

function expectConfiguredShortcodeCall(callIndex: number): void {
  const configured = configuredShortcodeRequests[callIndex];
  const call = vi.mocked(globalThis.fetch).mock.calls[callIndex];
  if (!configured || !call) throw new Error(`Missing configured request call ${callIndex + 1}`);

  const [input, init] = call;
  if (configured.request.transport === 'form') {
    expect(input).toBe(configured.request.endpoint);
    expect(init).toEqual(
      expect.objectContaining({ method: 'POST', body: expect.any(URLSearchParams) })
    );
    return;
  }

  const requestUrl =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  expect(requestUrl).toContain(configured.request.endpoint);
  expect(requestUrl).toContain(`${configured.candidate.kind}=${configured.candidate.id}`);
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

  it('re-activates the native bridge when the browser starts', async () => {
    await import('./background');

    const startup = fakeBrowserObj.getStartupListener();
    expect(startup).not.toBeNull();
    startup?.();

    expect(fakeBrowserObj.fakeBrowser.runtime.connectNative).toHaveBeenCalledTimes(1);
  });

  it('registers an idempotent GramGrab submenu and routes link commands', async () => {
    await import('./background');
    await Promise.resolve();
    expect(fakeBrowserObj.fakeBrowser.contextMenus.create).toHaveBeenCalledTimes(3);
    const click = fakeBrowserObj.getContextClickListener()!;
    click({
      menuItemId: 'gramgrab-fetch',
      pageUrl: 'https://elsewhere.example/',
      linkUrl: 'http://instagram.com/stories/person/123/',
    });
    await vi.waitFor(() => {
      expect(fakeBrowserObj.fakeBrowser.sessionStorage.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'workspace-transfer-v1': expect.objectContaining({
            url: 'https://www.instagram.com/stories/person/',
            intent: 'fetch',
          }),
        })
      );
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

  it('decodes a plain runner failure before encoding it to the native protocol', async () => {
    const listener = await loadBackground();
    const operationId = Schema.decodeUnknownSync(OperationId)(
      '00000000-0000-4000-8000-000000000001'
    );
    fakeBrowserObj.fakeBrowser.tabs.sendMessage.mockResolvedValue({
      _tag: 'ExportResult',
      outcomes: [
        {
          _tag: 'ItemFailed',
          operationId,
          itemNumber: 1,
          mediaIdentity: { itemIndex: 0 },
          failure: { code: 'FRAME_TIMEOUT', scope: 'item' },
        },
      ],
    });
    const request = Schema.decodeUnknownSync(Request)({
      version: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      command: Export.make({
        sourceUrl: 'https://www.instagram.com/p/example/',
        operations: [
          ExportOperation.make({
            operationId,
            itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(1),
            mode: FrameExport.make({ timestampSeconds: 0 }),
          }),
        ],
      }),
    });

    fakeBrowserObj.getNativeMessageListener()?.(Schema.encodeSync(Request)(request));
    await vi.waitFor(() =>
      expect(fakeBrowserObj.fakeBrowser.windows.create).toHaveBeenCalledWith({
        url: 'chrome-extension://test/runner.html',
        focused: false,
        state: 'minimized',
        type: 'popup',
      })
    );
    listener({ type: 'RUNNER_READY' }, { tab: { id: 1 } }, vi.fn());

    await vi.waitFor(() =>
      expect(fakeBrowserObj.nativeMessages).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            _tag: 'Completed',
            result: expect.objectContaining({
              _tag: 'ExportResult',
              outcomes: [
                expect.objectContaining({
                  _tag: 'ItemFailed',
                  failure: { code: 'FRAME_TIMEOUT', scope: 'item' },
                }),
              ],
            }),
          }),
        })
      )
    );
  });

  it('direct native Instant export reconciles a reordered feed by media ID', async () => {
    const fixture = instantFixture('instants-photo.json') as {
      data: { xdt_get_quick_snaps: { items_ordered_by_time: Record<string, unknown>[] } };
    };
    const target = fixture.data.xdt_get_quick_snaps.items_ordered_by_time[0]!;
    const targetId = String(target.id);
    const other = structuredClone(target);
    other.id = 'other-instant';
    for (const candidate of (target.image_versions2 as { candidates: { url: string }[] })
      .candidates)
      candidate.url = 'https://cdn.instagram.com/fresh-target.jpg';
    for (const candidate of (other.image_versions2 as { candidates: { url: string }[] }).candidates)
      candidate.url = 'https://cdn.instagram.com/wrong-item.jpg';
    fixture.data.xdt_get_quick_snaps.items_ordered_by_time = [other, target];
    globalThis.fetch = fetchMock(async () => jsonResponse(fixture));
    await loadBackground();
    const operationId = Schema.decodeUnknownSync(OperationId)(
      '00000000-0000-4000-8000-000000000002'
    );
    const request = Schema.decodeUnknownSync(Request)({
      version: PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      command: InstantsExport.make({
        operations: [
          ExportOperation.make({
            operationId,
            itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(1),
            mediaIdentity: MediaIdentity.make({
              itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(0),
              mediaId: targetId,
            }),
            mode: DirectExport.make({}),
          }),
        ],
      }),
    });

    fakeBrowserObj.getNativeMessageListener()?.(Schema.encodeSync(Request)(request));

    await vi.waitFor(() =>
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://cdn.instagram.com/fresh-target.jpg' })
      )
    );
    expect(fakeBrowserObj.fakeBrowser.downloads.download).not.toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://cdn.instagram.com/wrong-item.jpg' })
    );
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
      const result = (await invoke(listener, {
        type: 'DOWNLOAD_MEDIA',
        operations: Array.from({ length: 10 }, (_, i) => ({
          operationId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          requestId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          itemIndex: i,
          url: `https://cdn.instagram.com/${i}.jpg`,
          filename: `hint_${i}.jpg`,
          originalUrl: `https://cdn.instagram.com/${i}.jpg`,
          originalFilename: `hint_${i}.jpg`,
          mediaType: 'image',
        })),
      })) as { results: { requestId: string; status: string }[] };

      expect(maxInflight).toBeLessThanOrEqual(3);
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledTimes(10);
      expect(result.results).toHaveLength(10);
    });

    it('returns a correlated failure for each rejected browser download without exposing its cause', async () => {
      fakeBrowserObj.fakeBrowser.downloads.download.mockRejectedValue(
        new Error('signed url token=secret')
      );
      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'DOWNLOAD_MEDIA',
        operations: [
          {
            operationId: '10000000-0000-4000-8000-000000000001',
            requestId: '00000000-0000-4000-8000-000000000001',
            itemIndex: 0,
            url: 'https://cdn.instagram.com/secret.jpg',
            filename: 'secret.jpg',
            originalUrl: 'https://cdn.instagram.com/secret.jpg',
            originalFilename: 'secret.jpg',
            mediaType: 'image',
          },
        ],
      })) as {
        results: {
          requestId: string;
          status: string;
          failure?: { code: string; cause?: unknown };
        }[];
      };
      expect(result.results).toEqual([
        expect.objectContaining({
          requestId: '00000000-0000-4000-8000-000000000001',
          status: 'failed',
          failure: expect.objectContaining({ code: 'DOWNLOAD_UNEXPECTED_FAILURE' }),
        }),
      ]);
      expect(JSON.stringify(result.results[0]?.failure)).toContain('signed url token=secret');
    });

    it('rejects legacy and malformed payloads as a batch error', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD_MEDIA',
        urls: ['https://cdn.instagram.com/legacy.jpg'],
      });
      expect(result).toMatchObject({
        results: [],
        failure: expect.objectContaining({ code: 'DOWNLOAD_UNEXPECTED_FAILURE' }),
      });
    });
  });

  describe('frame export history', () => {
    it('records history only after a non-empty frame download completes', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD_FRAME_EXPORT',
        dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
        sourceUrl: 'https://www.instagram.com/p/abc123/',
        item: {
          itemIndex: 0,
          url: 'https://cdn.instagram.com/video.mp4',
          filename: 'post_frame.jpg',
          mediaType: 'video',
          frameTimestampSeconds: 0,
        },
      });

      expect(result).toEqual({ error: undefined });
      expect(fakeBrowserObj.fakeBrowser.downloads.search).toHaveBeenCalledWith({ id: 1 });
      expect(fakeBrowserObj.fakeBrowser.storage.set).toHaveBeenCalled();
    });

    it('does not record an empty completed frame download', async () => {
      fakeBrowserObj.fakeBrowser.downloads.search.mockResolvedValue([
        { id: 1, state: 'complete', fileSize: 0 },
      ]);
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'DOWNLOAD_FRAME_EXPORT',
        dataUrl: 'data:image/jpeg;base64,',
        sourceUrl: 'https://www.instagram.com/p/abc123/',
        item: {
          itemIndex: 0,
          url: 'https://cdn.instagram.com/video.mp4',
          filename: 'post_frame.jpg',
          mediaType: 'video',
          frameTimestampSeconds: 0,
        },
      });

      expect(result).toEqual({ error: 'Frame download failed.' });
      expect(fakeBrowserObj.fakeBrowser.storage.set).not.toHaveBeenCalled();
    });

    it('records a historical frame re-download using its immutable filename', async () => {
      const listener = await loadBackground();
      const result = await invoke(listener, {
        type: 'RECORD_FRAME_EXPORT',
        sourceUrl: 'https://www.instagram.com/p/abc123/',
        item: {
          itemIndex: 0,
          url: 'https://cdn.instagram.com/video.mp4',
          filename: 'post_frame_00-05.jpg',
          mediaType: 'video',
          frameTimestampSeconds: 5,
        },
      });
      expect(result).toEqual({ error: undefined });
      expect(fakeBrowserObj.fakeBrowser.storage.set).toHaveBeenCalledWith({
        'download-history': expect.objectContaining({
          entries: [
            expect.objectContaining({
              filenameHint: 'post_frame_00-05',
              exportMode: 'frame',
              frameTimestampSeconds: 5,
            }),
          ],
        }),
      });
    });
  });

  describe('Instant history re-download', () => {
    const historyStore = (mediaId: string) => ({
      'download-history': {
        version: 3,
        entries: [
          {
            id: 'instant-history',
            origin: { kind: 'instants' },
            itemIndex: 0,
            mediaId,
            mediaType: 'image',
            filenameHint: 'original_filename',
            exportMode: 'direct',
            downloadedAt: 1,
            outcome: 'accepted',
          },
        ],
      },
    });

    it('uses fresh media identity after the active feed reorders', async () => {
      const fixture = instantFixture('instants-photo.json') as {
        data: { xdt_get_quick_snaps: { items_ordered_by_time: Record<string, unknown>[] } };
      };
      const target = fixture.data.xdt_get_quick_snaps.items_ordered_by_time[0]!;
      const mediaId = String(target.id);
      const other = structuredClone(target);
      other.id = 'other-instant';
      const targetImages = target.image_versions2 as {
        candidates: { url: string }[];
      };
      const otherImages = other.image_versions2 as {
        candidates: { url: string }[];
      };
      for (const candidate of targetImages.candidates)
        candidate.url = 'https://cdn.instagram.com/fresh-target.jpg';
      for (const candidate of otherImages.candidates)
        candidate.url = 'https://cdn.instagram.com/wrong-item.jpg';
      fixture.data.xdt_get_quick_snaps.items_ordered_by_time = [other, target];
      fakeBrowserObj.fakeBrowser.storage.get.mockResolvedValue(historyStore(mediaId));
      globalThis.fetch = fetchMock(async () => jsonResponse(fixture));

      const response = await invoke(await loadBackground(), {
        type: 'REDOWNLOAD_HISTORY_ENTRY',
        entryId: 'instant-history',
      });

      expect(response).toMatchObject({ results: [{ status: 'started' }] });
      expect(fakeBrowserObj.fakeBrowser.downloads.download).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://cdn.instagram.com/fresh-target.jpg' })
      );
    });

    it('keeps History and reports an inactive Instant without downloading', async () => {
      fakeBrowserObj.fakeBrowser.storage.get.mockResolvedValue(historyStore('expired-instant'));
      globalThis.fetch = fetchMock(async () => jsonResponse(instantFixture('instants-empty.json')));

      const response = await invoke(await loadBackground(), {
        type: 'REDOWNLOAD_HISTORY_ENTRY',
        entryId: 'instant-history',
      });

      expect(response).toMatchObject({
        error: 'This Instant is no longer active. History was kept.',
        failureCode: 'INSTANT_NOT_ACTIVE',
      });
      expect(fakeBrowserObj.fakeBrowser.downloads.download).not.toHaveBeenCalled();
      expect(fakeBrowserObj.fakeBrowser.storage.remove).not.toHaveBeenCalled();
    });

    it('preserves authentication failure identity while refreshing Instant History', async () => {
      fakeBrowserObj.fakeBrowser.storage.get.mockResolvedValue(historyStore('instant-media'));
      globalThis.fetch = fetchMock(async () => jsonResponse({}, 401));

      const response = await invoke(await loadBackground(), {
        type: 'REDOWNLOAD_HISTORY_ENTRY',
        entryId: 'instant-history',
      });

      expect(response).toMatchObject({ failureCode: 'IG_NOT_AUTHENTICATED' });
      expect(fakeBrowserObj.fakeBrowser.downloads.download).not.toHaveBeenCalled();
    });
  });

  // ── FETCH_MEDIA (shortcode fallback) ─────────────────────────────────────

  describe('FETCH_INSTANTS', () => {
    it.each([
      ['photo', 'instants-photo.json', 1],
      ['video', 'instants-video.json', 1],
      ['empty', 'instants-empty.json', 0],
      ['unknown typename', 'instants-unknown.json', 0],
    ])('loads the sanitized %s fixture', async (_label, name, expectedCount) => {
      const fixture = instantFixture(name);
      globalThis.fetch = fetchMock(async () => jsonResponse(fixture));
      const response = (await invoke(await loadBackground(), { type: 'FETCH_INSTANTS' })) as {
        media?: unknown[];
        failure?: unknown;
      };
      expect(response.failure).toBeUndefined();
      expect(response.media).toHaveLength(expectedCount);
      const [input, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
      expect(input).toBe(
        protocolConfig.operations.instantsFeed?.candidates[0]?.requests[0]?.endpoint
      );
      expect(init?.headers).toEqual(
        expect.objectContaining({
          'X-IG-App-ID': protocolConfig.operations.instantsFeed?.appId,
          'X-FB-Friendly-Name': 'IGQuickSnapGetQuickSnapsQuery',
          'X-CSRFToken': 'current-csrf-token',
        })
      );
      expect(fakeBrowserObj.fakeBrowser.cookies.get).toHaveBeenCalledWith({
        url: 'https://www.instagram.com/',
        name: 'csrftoken',
      });
      const body = init?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      if (!(body instanceof URLSearchParams)) throw new Error('Expected an Instant form body');
      expect(body.toString()).not.toContain('seen');
    });

    it.each([
      [
        'instants-photo.json',
        'https://sanitized.invalid/media/26/instant-image',
        'sanitized_person_3_username',
      ],
      [
        'instants-video.json',
        'https://sanitized.invalid/media/27/instant-video',
        'sanitized_person_4_username',
      ],
    ])('selects the verified candidate policy for %s', async (name, url, username) => {
      const fixture = instantFixture(name);
      globalThis.fetch = fetchMock(async () => jsonResponse(fixture));
      const response = (await invoke(await loadBackground(), { type: 'FETCH_INSTANTS' })) as {
        media?: { url: string; creatorUsername?: string }[];
      };
      expect(response.media?.[0]).toMatchObject({ url, creatorUsername: username });
    });

    it('fails loudly for an invalid known shape and DASH-only video', async () => {
      for (const [name, code] of [
        ['instants-invalid-known.json', 'IG_RESPONSE_SHAPE_UNKNOWN'],
        ['instants-dash-only.json', 'MEDIA_DASH_ONLY_UNSUPPORTED'],
      ] as const) {
        vi.resetModules();
        fakeBrowserObj = makeFakeBrowser();
        globalThis.browser = fakeBrowserObj.fakeBrowser;
        const fixture = instantFixture(name);
        globalThis.fetch = fetchMock(async () => jsonResponse(fixture));
        const response = (await invoke(await loadBackground(), { type: 'FETCH_INSTANTS' })) as {
          failure?: { code: string };
        };
        expect(response.failure?.code).toBe(code);
      }
    });
  });

  describe('FETCH_MEDIA — shortcode fallback', () => {
    it('tries the next configured request when the first response has no node', async () => {
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
      installFetchSequence([missingShortcodeResponse(), jsonResponse(fallbackMedia)]);

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
      expectConfiguredShortcodeCall(1);
    });

    it('tries the next configured request when the first response is non-json', async () => {
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
      installFetchSequence([
        new Response('<!doctype html>', { status: 200 }),
        jsonResponse(fallbackMedia),
      ]);

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
      expectConfiguredShortcodeCall(1);
    });

    it('tries the next configured candidate after exhausting the first candidate', async () => {
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
      const firstRequest = configuredShortcodeRequests[0];
      if (!firstRequest) throw new Error('No configured shortcode requests');
      const nextCandidateIndex = configuredShortcodeRequests.findIndex(
        configured => configured.candidate.id !== firstRequest.candidate.id
      );
      if (nextCandidateIndex < 1) throw new Error('No shortcode fallback candidate configured');
      installFetchSequence([
        ...configuredShortcodeRequests
          .slice(0, nextCandidateIndex)
          .map(() => missingShortcodeResponse()),
        jsonResponse(fallbackMedia),
      ]);

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
      expect(globalThis.fetch).toHaveBeenCalledTimes(nextCandidateIndex + 1);
      expectConfiguredShortcodeCall(nextCandidateIndex);
    });

    it('surfaces the last failure when every configured shortcode request fails', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      installFetchSequence(
        configuredShortcodeRequests.map((_, index) =>
          index === configuredShortcodeRequests.length - 1
            ? new Response(null, { status: 403 })
            : missingShortcodeResponse()
        )
      );

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/forbidden1/',
      })) as { media: undefined; failure: { code: string } };

      expect(result.media).toBeUndefined();
      expect(result.failure.code).toBe('IG_ACCESS_FORBIDDEN');
      expect(globalThis.fetch).toHaveBeenCalledTimes(configuredShortcodeRequests.length);
    });

    it('surfaces malformed shortcode responses when every fallback is empty', async () => {
      document.body.innerHTML = '<input name="lsd" value="token123" />';
      installFetchSequence(
        configuredShortcodeRequests.map((_, index) =>
          index === 0 ? jsonResponse({ data: [] }) : missingShortcodeResponse()
        )
      );

      const listener = await loadBackground();
      const result = (await invoke(listener, {
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/p/broken1/',
      })) as { media: undefined; failure: { code: string } };

      expect(result.media).toBeUndefined();
      expect(result.failure.code).toBe('IG_RESPONSE_SHAPE_UNKNOWN');
      expect(globalThis.fetch).toHaveBeenCalledTimes(configuredShortcodeRequests.length);
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
      })) as { media: undefined; failure: { code: string } };

      expect(result.media).toBeUndefined();
      expect(result.failure.code).toBe('IG_RESPONSE_SHAPE_UNKNOWN');
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
      expect(result).toMatchObject({ failure: { code: 'IG_REQUEST_REJECTED' } });
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
