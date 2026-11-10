import { browser } from '../lib/browser';
import type { MediaItem } from '../popup/media-item.ts';
import { CropSchema } from '../crop/contracts.ts';
import { RotationSchema } from '../rotation/contracts.ts';
import { Option, Schema } from 'effect';
import { InstagramLogin } from '@gramgrab/protocol';

export type WorkspaceMediaItem = MediaItem;

/** Item shape belongs to `sanitizeSnapshot`, the only writer, so reading checks only for an array. */
const WorkspaceMediaItems = Schema.declare((input: unknown): input is WorkspaceMediaItem[] =>
  Array.isArray(input)
);

const WorkspaceSnapshotSchema = Schema.Struct({
  version: Schema.Literal(4),
  acquisition: Schema.Struct({ kind: Schema.Literal('source', 'instants') }),
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
  url: Schema.String,
  fetchedUrl: Schema.String,
  status: Schema.Literal('idle', 'done', 'error'),
  message: Schema.String,
  mediaItems: WorkspaceMediaItems,
  frameExportSettings: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({ enabled: Schema.Boolean, timestampSeconds: Schema.Number }),
  }),
  removeAudioIndexes: Schema.mutable(Schema.Array(Schema.Number)),
  autoStartDownload: Schema.optional(Schema.Boolean),
  intent: Schema.optional(Schema.Literal('open', 'fetch')),
  /** The login the results were fetched as. Absent means the main login. */
  login: Schema.optional(InstagramLogin),
  /** The item whose crop selector opens when the workspace claims this snapshot. */
  cropIndex: Schema.optional(Schema.Number),
});

export type WorkspaceSnapshot = typeof WorkspaceSnapshotSchema.Type;

const decodeSnapshot = Schema.decodeUnknownOption(WorkspaceSnapshotSchema);

/** Reads a claimed transfer, or `undefined` when it is malformed or past its expiry. */
export function decodeWorkspaceSnapshot(value: unknown): WorkspaceSnapshot | undefined {
  return Option.getOrUndefined(
    Option.filter(decodeSnapshot(value), snapshot => snapshot.expiresAt > Date.now())
  );
}

const isRotation = Schema.is(RotationSchema);
const isCrop = Schema.is(CropSchema);

export const WORKSPACE_TRANSFER_KEY = 'workspace-transfer-v1';
export const WORKSPACE_STATUS_KEY = 'workspace-status-v1';
export const WORKSPACE_TRANSFER_TTL_MS = 60_000;

export function workspaceUrl(sourceUrl = '', offerId = ''): string {
  const base = browser.runtime.getURL('popup.html');
  const url = new URL(base);
  url.searchParams.set('surface', 'workspace');
  if (sourceUrl) url.searchParams.set('source', sourceUrl);
  if (offerId) url.searchParams.set('offer', offerId);
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

function isUsernamePathSegment(value: string): boolean {
  return USERNAME.test(value) && !RESERVED_PROFILE_PATHS.has(value.toLowerCase());
}

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
  if (path.length !== 2 || !['reel', 'reels'].includes(path[0]!) || !SHORTCODE.test(path[1]!))
    return undefined;
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
  if (path.length !== 1 || !isUsernamePathSegment(path[0]!)) return undefined;
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
    const permanentMediaPath =
      path.length === 3 && isUsernamePathSegment(path[0]!) ? path.slice(1) : path;
    const parsed = [
      parsePost(permanentMediaPath, url.searchParams.get('img_index')),
      parseReel(permanentMediaPath),
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

function sanitizeMediaPreview(item: WorkspaceMediaItem) {
  return {
    ...(item.previewUrl && !item.previewUrl.startsWith('data:')
      ? { previewUrl: item.previewUrl }
      : {}),
    ...(isPositiveFinitePair(item.width, item.height)
      ? { width: item.width, height: item.height }
      : {}),
  };
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
      ...(isRotation(item.rotation) ? { rotation: item.rotation } : {}),
      ...(isCrop(item.crop) ? { crop: item.crop } : {}),
      ...sanitizeMediaPreview(item),
      ...(item.creatorUsername ? { creatorUsername: item.creatorUsername } : {}),
      ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
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
    removeAudioIndexes: snapshot.removeAudioIndexes.filter(
      index => Number.isSafeInteger(index) && index >= 0
    ),
  };
}

function isPositiveFinitePair(width: number | undefined, height: number | undefined): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0;
}
