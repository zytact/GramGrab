export const DOWNLOAD_HISTORY_KEY = 'download-history';
export const DOWNLOAD_HISTORY_VERSION = 1 as const;
export const DOWNLOAD_HISTORY_LIMIT = 1000;

export type HistorySourceKind = 'post' | 'reel' | 'story' | 'highlight' | 'profile';
export type HistoryMediaType = 'image' | 'video';

/** Deliberately redacted durable record. It has no media or preview URL. */
export interface DownloadHistoryEntryV1 {
  id: string;
  sourceUrl: string;
  sourceKind: HistorySourceKind;
  itemIndex: number;
  mediaId?: string;
  mediaType: HistoryMediaType;
  filenameHint: string;
  downloadedAt: number;
  outcome: 'accepted';
}

export interface DownloadHistoryStoreV1 {
  version: typeof DOWNLOAD_HISTORY_VERSION;
  entries: DownloadHistoryEntryV1[];
}

export type HistoryReadResult =
  | { kind: 'ok'; entries: DownloadHistoryEntryV1[]; repaired: boolean }
  | { kind: 'unknown-version'; entries: [] };

export interface HistoryMarker {
  downloaded: boolean;
  count: number;
  latestDownloadedAt?: number;
}
