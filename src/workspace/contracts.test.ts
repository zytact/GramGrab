import { describe, expect, it } from 'vite-plus/test';
import {
  canonicalizeInstagramUrl,
  isInstagramSource,
  sanitizeSnapshot,
  upgradeWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from './contracts';

const snapshot: WorkspaceSnapshot = {
  version: 3,
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
      width: 1080,
      height: 1920,
    },
  ],
  frameExportSettings: {},
  removeAudioIndexes: [],
};

describe('workspace contracts', () => {
  it('accepts only Instagram HTTP sources', () => {
    expect(isInstagramSource('https://www.instagram.com/p/example/')).toBe(true);
    expect(isInstagramSource('https://instagram.com/p/example/')).toBe(true);
    expect(isInstagramSource('https://notinstagram.com/p/example/')).toBe(false);
    expect(isInstagramSource('not a URL')).toBe(false);
  });

  it('strictly canonicalizes supported targets', () => {
    expect(
      canonicalizeInstagramUrl('http://instagram.com/p/example/?img_index=2&utm=x#comments')
    ).toMatchObject({
      url: 'https://www.instagram.com/p/example/?img_index=2',
      target: { type: 'post', shortcode: 'example', carouselIndex: 1 },
    });
    expect(canonicalizeInstagramUrl('https://www.instagram.com/stories/name/12345/')).toMatchObject(
      { url: 'https://www.instagram.com/stories/name/', target: { type: 'story' } }
    );
    expect(canonicalizeInstagramUrl('https://www.instagram.com/explore/')).toBeNull();
    expect(canonicalizeInstagramUrl('https://evilinstagram.com/p/example/')).toBeNull();
    expect(canonicalizeInstagramUrl('ftp://www.instagram.com/p/example/')).toBeNull();
    expect(canonicalizeInstagramUrl('https://www.instagram.com/p/example/extra/')).toBeNull();
  });

  it('removes transient data URL previews from transfers', () => {
    const item = sanitizeSnapshot(snapshot).mediaItems[0];
    expect(item?.previewUrl).toBeUndefined();
    expect(item).toMatchObject({ width: 1080, height: 1920 });
  });

  it('keeps older geometry-free snapshots valid', () => {
    const olderSnapshot = sanitizeSnapshot({
      ...snapshot,
      mediaItems: [{ ...snapshot.mediaItems[0]!, width: undefined, height: undefined }],
    });
    expect(olderSnapshot.mediaItems[0]).not.toHaveProperty('width');
    expect(olderSnapshot.mediaItems[0]).not.toHaveProperty('height');
  });

  it('upgrades version 1 frame selections to default frame timestamps', () => {
    const legacy = {
      ...snapshot,
      version: 1 as const,
      exportFrameIndexes: [0],
    };
    const upgraded = upgradeWorkspaceSnapshot(legacy);
    expect(upgraded).toMatchObject({
      version: 3,
      removeAudioIndexes: [],
      frameExportSettings: { 0: { enabled: true, timestampSeconds: 5 } },
    });
  });

  it.each([
    { width: 0, height: 1920 },
    { width: 1080, height: -1 },
    { width: Number.NaN, height: 1920 },
    { width: 1080, height: Number.POSITIVE_INFINITY },
    { width: 1080, height: undefined },
  ])('removes invalid or incomplete geometry from transfers: %o', dimensions => {
    const sanitized = sanitizeSnapshot({
      ...snapshot,
      mediaItems: [{ ...snapshot.mediaItems[0]!, ...dimensions }],
    });

    expect(sanitized.mediaItems[0]).not.toHaveProperty('width');
    expect(sanitized.mediaItems[0]).not.toHaveProperty('height');
  });
});
