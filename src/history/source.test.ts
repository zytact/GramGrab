import { describe, expect, it } from 'vite-plus/test';
import { reconcileHistoryEntry } from './reconciliation.ts';
import { historySource } from './source.ts';

describe('download history source identity', () => {
  it('removes a Post img_index while retaining the supported canonical source', () => {
    expect(historySource('http://instagram.com/p/example/?img_index=2&utm=x#comments')).toEqual({
      url: 'https://www.instagram.com/p/example/',
      kind: 'post',
    });
  });

  it('rejects unsupported sources', () => {
    expect(historySource('https://example.com/p/example/')).toBeNull();
  });
});

describe('history reconciliation', () => {
  const image = { itemIndex: 4, mediaId: 'stable-media', type: 'image' as const };

  it('uses a durable media ID before a moved index', () => {
    expect(
      reconcileHistoryEntry({ itemIndex: 1, mediaId: 'stable-media', mediaType: 'image' }, [image])
    ).toEqual({ kind: 'found', item: image });
  });

  it('does not fall back to an unrelated index when a durable ID disappeared', () => {
    expect(
      reconcileHistoryEntry({ itemIndex: 4, mediaId: 'gone', mediaType: 'image' }, [image])
    ).toEqual({ kind: 'missing' });
  });

  it('allows index fallback only without a durable ID and with a compatible type', () => {
    expect(reconcileHistoryEntry({ itemIndex: 4, mediaType: 'image' }, [image]).kind).toBe('found');
    expect(reconcileHistoryEntry({ itemIndex: 4, mediaType: 'video' }, [image]).kind).toBe(
      'missing'
    );
  });

  it('rejects ambiguous duplicate IDs unless the saved index disambiguates them', () => {
    const candidates = [image, { ...image, itemIndex: 8 }];
    expect(
      reconcileHistoryEntry(
        { itemIndex: 2, mediaId: 'stable-media', mediaType: 'image' },
        candidates
      ).kind
    ).toBe('ambiguous');
    expect(
      reconcileHistoryEntry(
        { itemIndex: 8, mediaId: 'stable-media', mediaType: 'image' },
        candidates
      ).kind
    ).toBe('found');
  });
});
