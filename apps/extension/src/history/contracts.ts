export const DOWNLOAD_HISTORY_KEY = 'download-history';
export const DOWNLOAD_HISTORY_VERSION = 3 as const;
export const DOWNLOAD_HISTORY_LIMIT = 1000;

export type HistorySourceKind = 'post' | 'reel' | 'story' | 'highlight' | 'profile';
export type HistoryMediaType = 'image' | 'video';
export type HistoryOrigin =
  | { kind: 'source'; sourceUrl: string; sourceKind: HistorySourceKind }
  | { kind: 'instants' };

/** Deliberately redacted durable record. It has no media or preview URL. */
export interface DownloadHistoryEntry {
  id: string;
  origin: HistoryOrigin;
  itemIndex: number;
  mediaId?: string;
  mediaType: HistoryMediaType;
  filenameHint: string;
  exportMode?: 'direct' | 'frame' | 'silent';
  frameTimestampSeconds?: number;
  downloadedAt: number;
  outcome: 'accepted';
}

export interface DownloadHistoryStoreV3 {
  version: typeof DOWNLOAD_HISTORY_VERSION;
  entries: DownloadHistoryEntry[];
}

export interface LegacyDownloadHistoryEntry extends Omit<DownloadHistoryEntry, 'origin'> {
  sourceUrl: string;
  sourceKind: HistorySourceKind;
}

export type HistoryReadResult =
  | { kind: 'ok'; entries: DownloadHistoryEntry[]; repaired: boolean }
  | { kind: 'unknown-version'; entries: [] };

export interface HistoryMarker {
  downloaded: boolean;
  count: number;
  latestDownloadedAt?: number;
}
