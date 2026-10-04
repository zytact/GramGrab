import type { Rotation } from '../rotation/contracts.ts';
import type { DownloadHistoryEntry } from './contracts.ts';

export interface AcceptedHistoryOperation {
  itemIndex: number;
  mediaId?: string;
  mediaType: 'image' | 'video';
  filename: string;
  exportMode?: 'direct' | 'frame' | 'silent';
  frameTimestampSeconds?: number;
  rotation?: Rotation;
}

function createHistoryId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/** The History receipt of one output the browser accepted. */
export function acceptedHistoryEntry(
  item: AcceptedHistoryOperation,
  origin: DownloadHistoryEntry['origin']
): DownloadHistoryEntry {
  return {
    id: createHistoryId(),
    origin,
    itemIndex: item.itemIndex,
    ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    mediaType: item.mediaType,
    filenameHint: item.filename.replace(/\.[^.]+$/, ''),
    ...(item.exportMode ? { exportMode: item.exportMode } : {}),
    ...(item.frameTimestampSeconds !== undefined
      ? { frameTimestampSeconds: item.frameTimestampSeconds }
      : {}),
    ...(item.rotation ? { rotation: item.rotation } : {}),
    downloadedAt: Date.now(),
    outcome: 'accepted',
  };
}
