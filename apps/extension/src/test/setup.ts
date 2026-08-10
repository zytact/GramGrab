import { vi } from 'vite-plus/test';

type BackgroundListener = (
  msg: unknown,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean | void;

let _bgListener: BackgroundListener | null = null;

// ---------------------------------------------------------------------------
// Blob.prototype.arrayBuffer polyfill
//
// jsdom does not implement Blob.prototype.arrayBuffer. We polyfill it here
// using a captured reference to the *original* FileReader so that tests which
// spy on globalThis.FileReader do NOT see the polyfill's internal usage.
// ---------------------------------------------------------------------------
interface BlobWithArrayBuffer extends Blob {
  arrayBuffer(): Promise<ArrayBuffer>;
}
const _OriginalFileReader =
  typeof globalThis.FileReader !== 'undefined' ? globalThis.FileReader : null;
if (
  typeof Blob !== 'undefined' &&
  typeof (Blob.prototype as BlobWithArrayBuffer).arrayBuffer !== 'function' &&
  _OriginalFileReader !== null
) {
  (Blob.prototype as BlobWithArrayBuffer).arrayBuffer = function (
    this: Blob
  ): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new _OriginalFileReader!();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

const mockTabs = [
  { id: 1, url: 'https://www.instagram.com/p/abc123/', active: true, currentWindow: true },
];
const mockTabRemovedListeners = new Set<(tabId: number) => void>();
const mockTabUpdatedListeners = new Set<
  (tabId: number, changeInfo: { url?: string; status?: string }) => void
>();
const mockDownloadChangedListeners = new Set<
  (delta: { id: number; state?: { current?: string } }) => void
>();

function makeMockPort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    name: 'gramgrab-whatsapp-capture-v1',
    postMessage: vi.fn(),
    disconnect: vi.fn(() => disconnectListeners.forEach(listener => listener())),
    onMessage: {
      addListener: vi.fn((listener: (message: unknown) => void) => messageListeners.add(listener)),
      removeListener: vi.fn((listener: (message: unknown) => void) =>
        messageListeners.delete(listener)
      ),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) => disconnectListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => disconnectListeners.delete(listener)),
    },
    emitMessage: (message: unknown) => messageListeners.forEach(listener => listener(message)),
  };
}

const mockDownloads = {
  downloads: [] as { url: string; filename?: string; saveAs?: boolean }[],
  download: vi
    .fn()
    .mockImplementation((options: { url: string; filename?: string; saveAs?: boolean }) => {
      mockDownloads.downloads.push(options);
      return Promise.resolve(1);
    }),
  cancel: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  onChanged: {
    addListener: vi.fn((listener: (delta: { id: number; state?: { current?: string } }) => void) =>
      mockDownloadChangedListeners.add(listener)
    ),
    removeListener: vi.fn(
      (listener: (delta: { id: number; state?: { current?: string } }) => void) =>
        mockDownloadChangedListeners.delete(listener)
    ),
  },
};

const mockMessageCallbacks: Map<string, (msg: unknown) => unknown> = new Map();

type MockBrowser = {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    getURL: ReturnType<typeof vi.fn>;
    onMessage: { addListener: ReturnType<typeof vi.fn> };
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    onRemoved: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    };
    onUpdated: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    };
  };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  downloads: typeof mockDownloads;
  storage: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  sessionStorage: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  windows: { update: ReturnType<typeof vi.fn> };
};

const mockBrowserInstance: MockBrowser = {
  runtime: {
    sendMessage: vi.fn().mockImplementation((msg: unknown) => {
      const type = (msg as { type: string }).type;
      const callback = mockMessageCallbacks.get(type);
      if (callback) {
        return Promise.resolve(callback(msg));
      }
      return Promise.resolve({});
    }),
    getURL: vi.fn().mockImplementation((path: string) => `chrome-extension://test/${path}`),
    onMessage: {
      addListener: vi.fn().mockImplementation((callback: (msg: unknown) => void) => {
        const type = (msg: unknown) => {
          const msgType = (msg as { type: string }).type;
          if (msgType === 'FETCH_MEDIA') {
            mockMessageCallbacks.set('FETCH_MEDIA', () => ({ media: [], error: undefined }));
          } else if (msgType === 'GET_PREVIEW_URL') {
            mockMessageCallbacks.set('GET_PREVIEW_URL', () => ({
              previewUrl: undefined,
              error: undefined,
            }));
          } else if (msgType === 'DOWNLOAD_MEDIA') {
            mockMessageCallbacks.set('DOWNLOAD_MEDIA', () => ({ error: undefined }));
          } else if (msgType === 'FETCH_VIDEO_BLOB') {
            mockMessageCallbacks.set('FETCH_VIDEO_BLOB', () => ({
              dataUrl: undefined,
              error: undefined,
            }));
          }
          return callback(msg);
        };
        return type;
      }),
    },
  },
  tabs: {
    query: vi.fn().mockImplementation(() => Promise.resolve(mockTabs)),
    connect: vi.fn().mockImplementation(() => makeMockPort()),
    create: vi.fn().mockResolvedValue({ id: 2 }),
    update: vi.fn().mockResolvedValue(undefined),
    onRemoved: {
      addListener: vi.fn((listener: (tabId: number) => void) =>
        mockTabRemovedListeners.add(listener)
      ),
      removeListener: vi.fn((listener: (tabId: number) => void) =>
        mockTabRemovedListeners.delete(listener)
      ),
    },
    onUpdated: {
      addListener: vi.fn(
        (listener: (tabId: number, changeInfo: { url?: string; status?: string }) => void) =>
          mockTabUpdatedListeners.add(listener)
      ),
      removeListener: vi.fn(
        (listener: (tabId: number, changeInfo: { url?: string; status?: string }) => void) =>
          mockTabUpdatedListeners.delete(listener)
      ),
    },
  },
  scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  downloads: mockDownloads,
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
  windows: { update: vi.fn().mockResolvedValue(undefined) },
};

globalThis.browser = mockBrowserInstance;

export const resetBrowserMocks = () => {
  mockDownloads.downloads = [];
  mockMessageCallbacks.clear();
  mockTabRemovedListeners.clear();
  mockTabUpdatedListeners.clear();
  mockDownloadChangedListeners.clear();
  vi.clearAllMocks();
};

export const setMockMessageHandler = (type: string, handler: (msg: unknown) => unknown) => {
  mockMessageCallbacks.set(type, handler);
};

export const getDownloadCalls = () => mockDownloads.downloads;
export const getMockBrowser = () => mockBrowserInstance;

/**
 * Loads background.ts fresh (via vi.resetModules) and wires browser.runtime.sendMessage
 * to route messages through the real background dispatcher. Mock handlers registered via
 * setMockMessageHandler take priority, letting individual tests stub specific message types
 * (e.g. FETCH_MEDIA) while routing everything else through real background logic.
 */
export async function loadBackground() {
  vi.resetModules();
  _bgListener = null;

  mockBrowserInstance.runtime.onMessage.addListener = vi.fn((cb: BackgroundListener) => {
    _bgListener = cb;
  });

  mockBrowserInstance.runtime.sendMessage = vi.fn().mockImplementation((msg: unknown) => {
    const type = (msg as { type: string }).type;
    const mockCb = mockMessageCallbacks.get(type);
    if (mockCb) {
      return Promise.resolve(mockCb(msg));
    }
    if (_bgListener) {
      return new Promise<unknown>(resolve => {
        const ret = _bgListener!(msg, {}, resolve);
        if (!ret) resolve(undefined);
      });
    }
    return Promise.resolve({});
  });

  await import('../background.ts');
}
