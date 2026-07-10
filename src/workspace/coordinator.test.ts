import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { replaceWorkspace } from './coordinator';
import type { WorkspaceSnapshot } from './contracts';

const snapshot: WorkspaceSnapshot = {
  version: 1,
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  url: 'https://www.instagram.com/p/example/',
  fetchedUrl: '',
  status: 'idle',
  message: 'Ready to fetch media.',
  mediaItems: [],
  exportFrameIndexes: [],
};

const mockBrowser = {
  runtime: { getURL: vi.fn().mockReturnValue('chrome-extension://test/popup.html') },
  tabs: {
    query: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: 9 }),
    update: vi.fn(),
  },
  storage: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn(),
  },
  windows: { update: vi.fn().mockResolvedValue(undefined) },
};

globalThis.browser = mockBrowser as typeof globalThis.browser;

describe('replaceWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser.tabs.create.mockResolvedValue({ id: 9 });
    mockBrowser.storage.set.mockResolvedValue(undefined);
  });

  it('creates a workspace when none exists', async () => {
    mockBrowser.tabs.query.mockResolvedValue([]);

    await expect(replaceWorkspace(snapshot)).resolves.toBe('created');
    expect(mockBrowser.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: 'chrome-extension://test/popup.html?surface=workspace&source=https%3A%2F%2Fwww.instagram.com%2Fp%2Fexample%2F',
    });
  });

  it('creates a workspace if the matched tab becomes stale before replacement', async () => {
    mockBrowser.tabs.query.mockResolvedValue([
      { id: 5, windowId: 1, url: 'chrome-extension://test/popup.html?surface=workspace' },
    ]);
    mockBrowser.tabs.update.mockRejectedValueOnce(new Error('No tab with id: 5'));

    await expect(replaceWorkspace(snapshot)).resolves.toBe('created');
    expect(mockBrowser.tabs.create).toHaveBeenCalledOnce();
  });
});
