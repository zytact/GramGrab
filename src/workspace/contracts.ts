import { browser } from '../lib/browser';

export interface WorkspaceMediaItem {
  index: number;
  type: string;
  url: string;
  filenameHint: string;
  selected: boolean;
  previewUrl?: string;
  width?: number;
  height?: number;
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
  intent?: 'open' | 'fetch';
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
  return canonicalizeInstagramUrl(value) !== null;
}

export interface InstagramTarget {
  type: 'post' | 'reel' | 'story' | 'highlight' | 'profile';
  shortcode?: string;
  username?: string;
  highlightId?: string;
  carouselIndex?: number;
}

export interface CanonicalInstagramUrl {
  url: string;
  target: InstagramTarget;
}

const RESERVED_PROFILE_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'stories',
  'explore',
  'direct',
  'accounts',
  'tv',
]);
const USERNAME = /^[a-zA-Z0-9._]{1,30}$/;
const SHORTCODE = /^[a-zA-Z0-9_-]+$/;
const NUMERIC_ID = /^\d+$/;

/** Returns a supported target and its single display/storage URL. */
export function canonicalizeInstagramUrl(value: string): CanonicalInstagramUrl | null {
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      !['instagram.com', 'www.instagram.com'].includes(url.hostname)
    )
      return null;
    const path = url.pathname.split('/').filter(Boolean);
    let target: InstagramTarget | undefined;
    let canonicalPath: string | undefined;
    if (path.length === 2 && path[0] === 'p' && SHORTCODE.test(path[1]!)) {
      const carouselIndex = parseCarouselIndex(url.searchParams.get('img_index'));
      target = { type: 'post', shortcode: path[1], carouselIndex };
      canonicalPath = `/p/${path[1]}/`;
      url.search = carouselIndex === undefined ? '' : `?img_index=${carouselIndex + 1}`;
    } else if (path.length === 2 && path[0] === 'reel' && SHORTCODE.test(path[1]!)) {
      target = { type: 'reel', shortcode: path[1] };
      canonicalPath = `/reel/${path[1]}/`;
      url.search = '';
    } else if (
      path.length === 3 &&
      path[0] === 'stories' &&
      path[1] === 'highlights' &&
      NUMERIC_ID.test(path[2]!)
    ) {
      target = { type: 'highlight', highlightId: path[2] };
      canonicalPath = `/stories/highlights/${path[2]}/`;
      url.search = '';
    } else if (
      (path.length === 2 || (path.length === 3 && NUMERIC_ID.test(path[2]!))) &&
      path[0] === 'stories' &&
      USERNAME.test(path[1]!)
    ) {
      target = { type: 'story', username: path[1] };
      canonicalPath = `/stories/${path[1]}/`;
      url.search = '';
    } else if (
      path.length === 1 &&
      USERNAME.test(path[0]!) &&
      !RESERVED_PROFILE_PATHS.has(path[0]!.toLowerCase())
    ) {
      target = { type: 'profile', username: path[0] };
      canonicalPath = `/${path[0]}/`;
      url.search = '';
    }
    if (!target || !canonicalPath) return null;
    url.protocol = 'https:';
    url.hostname = 'www.instagram.com';
    url.pathname = canonicalPath;
    url.hash = '';
    return { url: url.toString(), target };
  } catch {
    return null;
  }
}

function parseCarouselIndex(imgIndex: string | null): number | undefined {
  if (!imgIndex || !/^\d+$/.test(imgIndex)) return undefined;
  const index = Number(imgIndex);
  return Number.isSafeInteger(index) && index > 0 ? index - 1 : undefined;
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
      ...(isPositiveFinitePair(item.width, item.height)
        ? { width: item.width, height: item.height }
        : {}),
    })),
    exportFrameIndexes: [...snapshot.exportFrameIndexes],
  };
}

function isPositiveFinitePair(width: number | undefined, height: number | undefined): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0;
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
