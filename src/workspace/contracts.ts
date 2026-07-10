import { browser } from '../lib/browser';

export interface WorkspaceMediaItem {
  index: number;
  type: string;
  url: string;
  filenameHint: string;
  selected: boolean;
  previewUrl?: string;
}

export interface WorkspaceSnapshot {
  version: 1;
  createdAt: number;
  expiresAt: number;
  url: string;
  fetchedUrl: string;
  status: 'idle' | 'done' | 'error';
  message: string;
  mediaItems: WorkspaceMediaItem[];
  exportFrameIndexes: number[];
}

export const WORKSPACE_TRANSFER_KEY = 'workspace-transfer-v1';
export const WORKSPACE_TRANSFER_TTL_MS = 60_000;

export function workspaceUrl(sourceUrl = ''): string {
  const base = browser.runtime.getURL('popup.html');
  const url = new URL(base);
  url.searchParams.set('surface', 'workspace');
  if (sourceUrl) url.searchParams.set('source', sourceUrl);
  return url.toString();
}

export function isInstagramSource(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /(^|\.)instagram\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function isBusy(status: string): boolean {
  return status === 'fetching' || status === 'downloading';
}

export function sanitizeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    ...snapshot,
    mediaItems: snapshot.mediaItems.map(item => ({
      index: item.index,
      type: item.type,
      url: item.url,
      filenameHint: item.filenameHint,
      selected: item.selected,
      ...(item.previewUrl && !item.previewUrl.startsWith('data:')
        ? { previewUrl: item.previewUrl }
        : {}),
    })),
    exportFrameIndexes: [...snapshot.exportFrameIndexes],
  };
}

export function isValidSnapshot(value: unknown): value is WorkspaceSnapshot {
  const snapshot = value as Partial<WorkspaceSnapshot> | undefined;
  return (
    snapshot?.version === 1 &&
    typeof snapshot.createdAt === 'number' &&
    typeof snapshot.expiresAt === 'number' &&
    snapshot.expiresAt > Date.now() &&
    typeof snapshot.url === 'string' &&
    typeof snapshot.fetchedUrl === 'string' &&
    Array.isArray(snapshot.mediaItems) &&
    Array.isArray(snapshot.exportFrameIndexes)
  );
}
