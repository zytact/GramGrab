import { describe, expect, it } from 'vite-plus/test';
import { isInstagramSource, sanitizeSnapshot, type WorkspaceSnapshot } from './contracts';

const snapshot: WorkspaceSnapshot = {
  version: 1,
  createdAt: 1,
  expiresAt: Date.now() + 60_000,
  url: 'https://www.instagram.com/p/example/',
  fetchedUrl: 'https://www.instagram.com/p/example/',
  status: 'done',
  message: 'Ready',
  mediaItems: [
    {
      index: 0,
      type: 'image',
      url: 'https://cdn.example/image.jpg',
      filenameHint: 'image',
      selected: true,
      previewUrl: 'data:image/png;base64,preview',
    },
  ],
  exportFrameIndexes: [],
};

describe('workspace contracts', () => {
  it('accepts only Instagram HTTP sources', () => {
    expect(isInstagramSource('https://www.instagram.com/p/example/')).toBe(true);
    expect(isInstagramSource('https://instagram.com/p/example/')).toBe(true);
    expect(isInstagramSource('https://notinstagram.com/p/example/')).toBe(false);
    expect(isInstagramSource('not a URL')).toBe(false);
  });

  it('removes transient data URL previews from transfers', () => {
    expect(sanitizeSnapshot(snapshot).mediaItems[0]?.previewUrl).toBeUndefined();
  });
});
