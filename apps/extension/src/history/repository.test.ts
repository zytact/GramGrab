import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getMockBrowser, resetBrowserMocks } from '../test/setup.ts';
import { appendHistory, getHistory } from './repository.ts';

describe('download history origin migration', () => {
  beforeEach(resetBrowserMocks);

  it('migrates URL-only version 2 entries without changing their meaning', async () => {
    vi.mocked(getMockBrowser().storage.get).mockResolvedValueOnce({
      'download-history': {
        version: 2,
        entries: [
          {
            id: 'legacy-entry',
            sourceUrl: 'https://www.instagram.com/p/example/',
            sourceKind: 'post',
            itemIndex: 0,
            mediaId: 'media-1',
            mediaType: 'image',
            filenameHint: 'example',
            exportMode: 'direct',
            downloadedAt: 1,
            outcome: 'accepted',
          },
        ],
      },
    });

    await expect(getHistory()).resolves.toEqual({
      kind: 'ok',
      repaired: true,
      entries: [
        expect.objectContaining({
          id: 'legacy-entry',
          origin: {
            kind: 'source',
            sourceUrl: 'https://www.instagram.com/p/example/',
            sourceKind: 'post',
          },
          mediaId: 'media-1',
          exportMode: 'direct',
        }),
      ],
    });
  });

  it('persists an Instant origin without an ephemeral media URL or private response data', async () => {
    vi.mocked(getMockBrowser().storage.get).mockResolvedValue({});
    await appendHistory({
      id: 'instant-entry',
      origin: { kind: 'instants' },
      itemIndex: 0,
      mediaId: 'instant-media-1',
      mediaType: 'video',
      filenameHint: 'creator_instant_1',
      exportMode: 'silent',
      downloadedAt: 2,
      outcome: 'accepted',
    });

    const stored = vi.mocked(getMockBrowser().storage.set).mock.calls[0]?.[0];
    expect(stored).toMatchObject({
      'download-history': {
        version: 3,
        entries: [expect.objectContaining({ origin: { kind: 'instants' } })],
      },
    });
    expect(JSON.stringify(stored)).not.toContain('https://');
    expect(JSON.stringify(stored)).not.toContain('manifest');
  });
});
