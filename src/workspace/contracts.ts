import { browser } from '../lib/browser';
import type { FrameExportSetting } from '../frame-export/timestamp.ts';

export interface WorkspaceMediaItem {
  index: number;
  itemIndex?: number;
  mediaId?: string;
  history?: { downloaded: boolean; count: number; latestDownloadedAt?: number };
  type: string;
  url: string;
  filenameHint: string;
  selected: boolean;
  previewUrl?: string;
  width?: number;
  height?: number;
}

export interface WorkspaceSnapshot {
  version: 2;
  createdAt: number;
  expiresAt: number;
  url: string;
  fetchedUrl: string;
  status: 'idle' | 'done' | 'error';
  message: string;
  mediaItems: WorkspaceMediaItem[];
  frameExportSettings: Record<number, FrameExportSetting>;
  intent?: 'open' | 'fetch';
}

interface LegacyWorkspaceSnapshot extends Omit<
  WorkspaceSnapshot,
  'version' | 'frameExportSettings'
> {
  version: 1;
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

interface ParsedInstagramTarget {
  target: InstagramTarget;
  path: string;
  search?: string;
}

function parsePost(path: string[], imgIndex: string | null): ParsedInstagramTarget | undefined {
  if (path.length !== 2 || path[0] !== 'p' || !SHORTCODE.test(path[1]!)) return undefined;
  const carouselIndex = parseCarouselIndex(imgIndex);
  return {
    target: { type: 'post', shortcode: path[1], carouselIndex },
    path: `/p/${path[1]!}/`,
    search: carouselIndex === undefined ? '' : `?img_index=${carouselIndex + 1}`,
  };
}

function parseReel(path: string[]): ParsedInstagramTarget | undefined {
  if (path.length !== 2 || path[0] !== 'reel' || !SHORTCODE.test(path[1]!)) return undefined;
  return { target: { type: 'reel', shortcode: path[1] }, path: `/reel/${path[1]!}/` };
}

function parseHighlight(path: string[]): ParsedInstagramTarget | undefined {
  if (
    path.length !== 3 ||
    path[0] !== 'stories' ||
    path[1] !== 'highlights' ||
    !NUMERIC_ID.test(path[2]!)
  )
    return undefined;
  return {
    target: { type: 'highlight', highlightId: path[2] },
    path: `/stories/highlights/${path[2]!}/`,
  };
}

function parseStory(path: string[]): ParsedInstagramTarget | undefined {
  const hasStoryId = path.length === 3 && NUMERIC_ID.test(path[2]!);
  if ((path.length !== 2 && !hasStoryId) || path[0] !== 'stories' || !USERNAME.test(path[1]!))
    return undefined;
  return { target: { type: 'story', username: path[1] }, path: `/stories/${path[1]!}/` };
}

function parseProfile(path: string[]): ParsedInstagramTarget | undefined {
  if (
    path.length !== 1 ||
    !USERNAME.test(path[0]!) ||
    RESERVED_PROFILE_PATHS.has(path[0]!.toLowerCase())
  )
    return undefined;
  return { target: { type: 'profile', username: path[0] }, path: `/${path[0]!}/` };
}

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
    const parsed = [
      parsePost(path, url.searchParams.get('img_index')),
      parseReel(path),
      parseHighlight(path),
      parseStory(path),
      parseProfile(path),
    ].find((target): target is ParsedInstagramTarget => target !== undefined);
    if (!parsed) return null;
    url.protocol = 'https:';
    url.hostname = 'www.instagram.com';
    url.pathname = parsed.path;
    url.search = parsed.search ?? '';
    url.hash = '';
    return { url: url.toString(), target: parsed.target };
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
      ...(item.itemIndex !== undefined ? { itemIndex: item.itemIndex } : {}),
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      ...(item.history ? { history: item.history } : {}),
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
    frameExportSettings: Object.fromEntries(
      Object.entries(snapshot.frameExportSettings).flatMap(([index, setting]) =>
        Number.isSafeInteger(Number(index)) &&
        Number(index) >= 0 &&
        typeof setting?.enabled === 'boolean' &&
        Number.isSafeInteger(setting.timestampSeconds) &&
        setting.timestampSeconds >= 0
          ? [[index, { enabled: setting.enabled, timestampSeconds: setting.timestampSeconds }]]
          : []
      )
    ),
  };
}

function isPositiveFinitePair(width: number | undefined, height: number | undefined): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0;
}

// fallow-ignore-next-line complexity
function isValidSnapshot(value: unknown): value is WorkspaceSnapshot {
  const snapshot = value as
    | (Omit<Partial<WorkspaceSnapshot>, 'version'> & {
        version?: number;
        exportFrameIndexes?: unknown;
      })
    | undefined;
  const validBase =
    typeof snapshot?.createdAt === 'number' &&
    typeof snapshot.expiresAt === 'number' &&
    snapshot.expiresAt > Date.now() &&
    typeof snapshot.url === 'string' &&
    typeof snapshot.fetchedUrl === 'string' &&
    Array.isArray(snapshot.mediaItems);
  if (!validBase) return false;
  if (snapshot.version === 1) {
    const indexes = Array.isArray(snapshot.exportFrameIndexes) ? snapshot.exportFrameIndexes : [];
    return indexes.every(index => Number.isSafeInteger(index) && index >= 0);
  }
  return (
    snapshot.version === 2 &&
    typeof snapshot.frameExportSettings === 'object' &&
    snapshot.frameExportSettings !== null
  );
}

export function upgradeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | undefined {
  if (!isValidSnapshot(value)) return undefined;
  const snapshot = value as WorkspaceSnapshot | LegacyWorkspaceSnapshot;
  if (snapshot.version === 2) return snapshot;
  const settings = Object.fromEntries(
    (snapshot.exportFrameIndexes ?? []).map(index => [
      index,
      { enabled: true, timestampSeconds: 5 },
    ])
  );
  return { ...snapshot, version: 2, frameExportSettings: settings };
}
