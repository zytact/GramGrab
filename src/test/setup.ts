import { vi } from 'vitest';

const mockTabs = [
  { id: 1, url: 'https://www.instagram.com/p/abc123/', active: true, currentWindow: true },
];

const mockDownloads = {
  downloads: [] as { url: string; filename?: string; saveAs?: boolean }[],
  download: vi
    .fn()
    .mockImplementation((options: { url: string; filename?: string; saveAs?: boolean }) => {
      mockDownloads.downloads.push(options);
      return Promise.resolve(1);
    }),
  onDownloadStarted: {
    addListener: vi.fn(),
  },
};

const mockMessageCallbacks: Map<string, (msg: unknown) => unknown> = new Map();

global.browser = {
  runtime: {
    sendMessage: vi.fn().mockImplementation((msg: unknown) => {
      const type = (msg as { type: string }).type;
      const callback = mockMessageCallbacks.get(type);
      if (callback) {
        return Promise.resolve(callback(msg));
      }
      return Promise.resolve({});
    }),
    onMessage: {
      addListener: vi.fn().mockImplementation((callback: (msg: unknown) => void) => {
        const type = (msg: unknown) => {
          const msgType = (msg as { type: string }).type;
          if (msgType === 'DOWNLOAD') {
            mockMessageCallbacks.set('DOWNLOAD', () => ({ media: [], error: undefined }));
          } else if (msgType === 'FETCH_MEDIA') {
            mockMessageCallbacks.set('FETCH_MEDIA', () => ({ media: [], error: undefined }));
          } else if (msgType === 'GET_PREVIEW_URL') {
            mockMessageCallbacks.set('GET_PREVIEW_URL', () => ({
              previewUrl: undefined,
              error: undefined,
            }));
          } else if (msgType === 'DOWNLOAD_MEDIA') {
            mockMessageCallbacks.set('DOWNLOAD_MEDIA', () => ({ error: undefined }));
          }
          return callback(msg);
        };
        return type;
      }),
    },
  },
  tabs: {
    query: vi.fn().mockImplementation(() => Promise.resolve(mockTabs)),
  },
  downloads: mockDownloads,
  storage: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
  },
};

export const resetBrowserMocks = () => {
  mockDownloads.downloads = [];
  mockMessageCallbacks.clear();
  vi.clearAllMocks();
};

export const setMockMessageHandler = (type: string, handler: (msg: unknown) => unknown) => {
  mockMessageCallbacks.set(type, handler);
};

export const getDownloadCalls = () => mockDownloads.downloads;
