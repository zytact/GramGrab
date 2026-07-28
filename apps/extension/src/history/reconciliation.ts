import type { DownloadHistoryEntry, HistoryMediaType } from './contracts.ts';

export interface ReconciledMediaItem {
  itemIndex: number;
  mediaId?: string;
  type: HistoryMediaType;
}

export type Reconciliation =
  | { kind: 'found'; item: ReconciledMediaItem }
  | { kind: 'missing' }
  | { kind: 'ambiguous' };

export function reconcileHistoryEntry(
  entry: Pick<DownloadHistoryEntry, 'itemIndex' | 'mediaId' | 'mediaType'>,
  items: readonly ReconciledMediaItem[]
): Reconciliation {
  if (entry.mediaId) {
    const candidates = items.filter(item => item.mediaId === entry.mediaId);
    if (candidates.length === 1)
      return candidates[0]!.type === entry.mediaType
        ? { kind: 'found', item: candidates[0]! }
        : { kind: 'missing' };
    if (candidates.length > 1) return { kind: 'ambiguous' };
    return { kind: 'missing' };
  }
  const item = items.find(candidate => candidate.itemIndex === entry.itemIndex);
  return item && item.type === entry.mediaType ? { kind: 'found', item } : { kind: 'missing' };
}
