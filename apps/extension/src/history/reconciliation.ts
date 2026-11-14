import type { DownloadHistoryEntry, HistoryMediaType } from './contracts.ts';

export interface ReconciledMediaItem {
  itemIndex: number;
  mediaId?: string;
  type: HistoryMediaType;
}

export type Reconciliation<Item extends ReconciledMediaItem> =
  | { kind: 'found'; item: Item }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

export function reconcileHistoryEntry<Item extends ReconciledMediaItem>(
  entry: Pick<DownloadHistoryEntry, 'itemIndex' | 'mediaId' | 'mediaType'>,
  items: readonly Item[]
): Reconciliation<Item> {
  if (entry.mediaId) {
    const [candidate, ...others] = items.filter(item => item.mediaId === entry.mediaId);
    if (others.length > 0) return { kind: 'ambiguous' };
    return candidate?.type === entry.mediaType
      ? { kind: 'found', item: candidate }
      : { kind: 'missing' };
  }
  const item = items.find(candidate => candidate.itemIndex === entry.itemIndex);
  return item && item.type === entry.mediaType ? { kind: 'found', item } : { kind: 'missing' };
}
