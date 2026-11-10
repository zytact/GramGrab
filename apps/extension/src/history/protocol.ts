import { Option, Schema } from 'effect';
import { HistoryEntry as ProtocolHistoryEntry } from '@gramgrab/protocol';
import type { DownloadHistoryEntry } from './contracts.ts';

const decodeProtocolEntry = Schema.decodeUnknownOption(ProtocolHistoryEntry);

export function protocolHistoryEntry(
  entry: Omit<DownloadHistoryEntry, 'requestedExport'> & { requestedExport?: unknown }
): Option.Option<ProtocolHistoryEntry> {
  return decodeProtocolEntry({
    id: entry.id,
    origin: entry.origin,
    mediaIdentity: {
      itemIndex: entry.itemIndex,
      ...(entry.mediaId ? { mediaId: entry.mediaId } : {}),
    },
    mediaType: entry.mediaType,
    filenameHint: entry.filenameHint,
    exportMode: entry.exportMode,
    rotation: entry.rotation,
    crop: entry.crop,
    requestedExport: entry.requestedExport,
    recovery: entry.recovery,
    frameTimestampSeconds: entry.frameTimestampSeconds,
    downloadedAt: entry.downloadedAt,
  });
}
