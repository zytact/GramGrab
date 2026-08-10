import { Either, Schema } from 'effect';

export const DOWNLOAD_HISTORY_KEY = 'download-history';
export const DOWNLOAD_HISTORY_VERSION = 4 as const;
export const DOWNLOAD_HISTORY_LIMIT = 1000;

export type HistorySourceKind = 'post' | 'reel' | 'story' | 'highlight' | 'profile';
export type HistoryMediaType = 'image' | 'video';
export type HistoryOrigin =
  | { kind: 'source'; sourceUrl: string; sourceKind: HistorySourceKind }
  | { kind: 'instants' };

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

export class WhatsAppHistoryReceipt extends Schema.Class<WhatsAppHistoryReceipt>(
  'WhatsAppHistoryReceipt'
)({
  source: Schema.Literal('whatsapp'),
  mediaKind: Schema.Literal('photo', 'video'),
  timestamp: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  savedFilename: Schema.String.pipe(Schema.nonEmptyString()),
  outcome: Schema.Literal('accepted'),
}) {}

const strictParseOptions = { onExcessProperty: 'error' as const };

export function decodeWhatsAppHistoryReceipt(value: unknown) {
  return Schema.decodeUnknownEither(WhatsAppHistoryReceipt, strictParseOptions)(value);
}

export function isWhatsAppHistoryReceipt(value: unknown): value is WhatsAppHistoryReceipt {
  return Either.isRight(decodeWhatsAppHistoryReceipt(value));
}

export type HistoryEntry = DownloadHistoryEntry | WhatsAppHistoryReceipt;

export interface DownloadHistoryStoreV4 {
  version: typeof DOWNLOAD_HISTORY_VERSION;
  entries: HistoryEntry[];
}

export type HistoryReadResult =
  | { kind: 'ok'; entries: HistoryEntry[]; repaired: boolean }
  | { kind: 'unknown-version'; entries: [] };

export interface HistoryMarker {
  downloaded: boolean;
  count: number;
  latestDownloadedAt?: number;
}
