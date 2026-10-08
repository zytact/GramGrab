import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { FrameExport } from '@gramgrab/protocol';
import { getMockBrowser, resetBrowserMocks } from '../test/setup.ts';
import {
  appendHistory,
  appendHistoryEntries,
  appendWhatsAppHistoryReceipt,
  getHistory,
  removeHistoryEntries,
} from './repository.ts';
import { WhatsAppHistoryReceipt, type DownloadHistoryEntry } from './contracts.ts';

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
        version: 4,
        entries: [expect.objectContaining({ origin: { kind: 'instants' } })],
      },
    });
    expect(JSON.stringify(stored)).not.toContain('https://');
    expect(JSON.stringify(stored)).not.toContain('manifest');
  });

  it('persists a WhatsApp receipt with exactly its five safe fields', async () => {
    vi.mocked(getMockBrowser().storage.get).mockResolvedValue({});
    await appendWhatsAppHistoryReceipt(
      WhatsAppHistoryReceipt.make({
        source: 'whatsapp',
        mediaKind: 'photo',
        timestamp: 1,
        savedFilename: 'whatsapp-visible-status-20260101T000000Z.jpg',
        outcome: 'accepted',
      })
    );

    const stored = vi.mocked(getMockBrowser().storage.set).mock.calls[0]?.[0];
    if (!stored) throw new Error('Expected a persisted History store.');
    const receipt = (stored['download-history'] as { entries: unknown[] }).entries[0];
    expect(receipt).toEqual({
      source: 'whatsapp',
      mediaKind: 'photo',
      timestamp: 1,
      savedFilename: 'whatsapp-visible-status-20260101T000000Z.jpg',
      outcome: 'accepted',
    });
    expect(Object.keys(receipt as object).sort()).toEqual([
      'mediaKind',
      'outcome',
      'savedFilename',
      'source',
      'timestamp',
    ]);
  });

  it('rejects WhatsApp receipts with any extra field while reading History', async () => {
    vi.mocked(getMockBrowser().storage.get).mockResolvedValue({
      'download-history': {
        version: 4,
        entries: [
          {
            source: 'whatsapp',
            mediaKind: 'video',
            timestamp: 1,
            savedFilename: 'whatsapp-visible-status-20260101T000000Z.mp4',
            outcome: 'accepted',
            captureId: 'must-not-persist',
          },
        ],
      },
    });

    await expect(getHistory()).resolves.toEqual({ kind: 'ok', entries: [], repaired: true });
  });

  it.each([2, 3, 4])('decodes export settings in version %i History', async version => {
    const origin =
      version === 2
        ? { sourceUrl: 'https://www.instagram.com/p/example/', sourceKind: 'post' }
        : {
            origin: {
              kind: 'source',
              sourceUrl: 'https://www.instagram.com/p/example/',
              sourceKind: 'post',
            },
          };
    const entry = {
      ...origin,
      itemIndex: 0,
      mediaType: 'video',
      filenameHint: 'instagram',
      downloadedAt: 1,
      outcome: 'accepted',
    };
    vi.mocked(getMockBrowser().storage.get).mockResolvedValue({
      'download-history': {
        version,
        entries: [
          {
            ...entry,
            id: 'valid',
            requestedExport: { mode: { _tag: 'FrameExport', timestampSeconds: 1.5 }, rotation: 90 },
          },
          {
            ...entry,
            id: 'invalid',
            requestedExport: { mode: { _tag: 'FrameExport', timestampSeconds: -1 } },
          },
        ],
      },
    });

    const history = await getHistory();
    expect(history).toMatchObject({ kind: 'ok', repaired: true, entries: [{ id: 'valid' }] });
    if (history.kind !== 'ok') throw new Error('Expected supported History.');
    const saved = history.entries.find(entry => 'id' in entry && entry.id === 'valid');
    if (!saved || !('id' in saved)) throw new Error('Expected the valid History entry.');
    expect(saved.requestedExport?.mode).toBeInstanceOf(FrameExport);
    expect(saved.requestedExport).toMatchObject({
      mode: { timestampSeconds: 1.5 },
      rotation: 90,
    });
  });
});

describe('batched history writes', () => {
  beforeEach(resetBrowserMocks);

  const entry = (id: string): DownloadHistoryEntry => ({
    id,
    origin: { kind: 'instants' },
    itemIndex: 0,
    mediaType: 'image',
    filenameHint: id,
    downloadedAt: 1,
    outcome: 'accepted',
  });

  it('writes one store update for a whole batch of entries', async () => {
    vi.mocked(getMockBrowser().storage.get).mockResolvedValue({});
    await appendHistoryEntries([entry('a'), entry('b'), entry('c')]);

    expect(vi.mocked(getMockBrowser().storage.set).mock.calls).toHaveLength(1);
    expect(vi.mocked(getMockBrowser().storage.set).mock.calls[0]?.[0]).toMatchObject({
      'download-history': {
        entries: [
          expect.objectContaining({ id: 'a' }),
          expect.objectContaining({ id: 'b' }),
          expect.objectContaining({ id: 'c' }),
        ],
      },
    });
  });

  it('removes every requested entry in one store update', async () => {
    vi.mocked(getMockBrowser().storage.get).mockResolvedValue({
      'download-history': { version: 4, entries: [entry('a'), entry('b'), entry('c')] },
    });
    await expect(removeHistoryEntries(['a', 'c'])).resolves.toEqual([
      expect.objectContaining({ id: 'b' }),
    ]);
    expect(vi.mocked(getMockBrowser().storage.set).mock.calls).toHaveLength(1);
  });
});
