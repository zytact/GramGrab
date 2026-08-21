import { Effect } from 'effect';
import { MediaDashOnlyUnsupported, ResponseShapeUnknown } from '../effect/errors.ts';
import type {
  HdAvatarUser,
  HighlightsTrayItem,
  InstantItem,
  InstantPhoto,
  InstantVideo,
  ReelItem,
  ShortcodeImage,
  ShortcodeNode,
  ShortcodeSidecar,
  ShortcodeVideo,
  StoryImageItem,
  StoryVideoItem,
  WebProfileInfoUser,
} from '../effect/schemas.ts';

const SHORTCODE_VIDEO_TYPENAMES = new Set([
  'XDTGraphVideo',
  'GraphVideo',
  'Video',
  'XDTMediaVideo',
  'ClipsShareVideo',
]);
const SHORTCODE_IMAGE_TYPENAMES = new Set([
  'XDTGraphImage',
  'GraphImage',
  'Image',
  'XDTMediaImage',
]);
const SHORTCODE_SIDECAR_TYPENAMES = new Set([
  'XDTGraphSidecar',
  'GraphSidecar',
  'Sidecar',
  'XDTMediaAlbum',
]);

type SidecarChild = NonNullable<
  NonNullable<ShortcodeSidecar['edge_sidecar_to_children']>['edges']
>[number]['node'];

interface MediaContext {
  takenAt?: number;
  filenameHint: string;
}

interface MediaDimensions {
  width?: number;
  height?: number;
}

function pickBestResource(
  resources: readonly { src: string; config_width?: number }[]
): string | null {
  if (resources.length === 0) return null;
  return (
    [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0))[0]?.src ?? null
  );
}

export interface MediaItem {
  itemIndex: number;
  mediaId?: string;
  type: 'image' | 'video';
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  takenAt?: number;
  filenameHint: string;
  creatorUsername?: string;
}

export function withItemIndexes(items: MediaItem[]): MediaItem[] {
  return items.map((item, itemIndex) => ({ ...item, itemIndex }));
}

function resolveHdUrl(hdUser: HdAvatarUser | undefined): string | undefined {
  if (!hdUser) return undefined;
  // Prefer full-res hd_profile_pic_url_info, then pick largest hd_profile_pic_versions entry
  if (hdUser.hd_profile_pic_url_info?.url) return hdUser.hd_profile_pic_url_info.url;
  if (hdUser.hd_profile_pic_versions && hdUser.hd_profile_pic_versions.length > 0) {
    return [...hdUser.hd_profile_pic_versions].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
      ?.url;
  }
  return hdUser.profile_pic_url;
}

export function normalizeProfilePicture(
  user: WebProfileInfoUser | undefined,
  username: string,
  hdUser?: HdAvatarUser
): MediaItem[] {
  // hd_profile_pic_url_info (1080px) > hd_profile_pic_versions > profile_pic_url_hd (320px)
  const picUrl = resolveHdUrl(hdUser) ?? user?.profile_pic_url_hd ?? user?.profile_pic_url;
  if (!picUrl) return [];
  return [
    {
      itemIndex: 0,
      mediaId: `profile-avatar:${username}`,
      type: 'image',
      url: picUrl,
      width: user?.profile_pic_dimensions?.width,
      height: user?.profile_pic_dimensions?.height,
      filenameHint: `${username}_profile`,
    },
  ];
}

function slugifyTitle(title: string | undefined): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function highlightIdTail(rawId: string | number): string {
  const s = String(rawId);
  const colonIdx = s.lastIndexOf(':');
  return colonIdx >= 0 ? s.slice(colonIdx + 1) : s;
}

export function normalizeHighlightCovers(
  tray: readonly HighlightsTrayItem[],
  username: string
): MediaItem[] {
  return tray.flatMap(entry => {
    const item = createHighlightCoverItem(entry, username);
    return item ? [item] : [];
  });
}

function createHighlightCoverItem(
  entry: HighlightsTrayItem,
  username: string
): MediaItem | undefined {
  const versions = getHighlightCoverVersions(entry);
  const downloadUrl = versions.full?.url ?? versions.cropped?.url;
  if (!downloadUrl) return undefined;

  return {
    itemIndex: 0,
    mediaId: String(entry.id),
    type: 'image',
    url: downloadUrl,
    previewUrl: buildHighlightPreviewUrl(versions.cropped?.url, downloadUrl),
    // The workspace renders the cropped URL when available, so its geometry must drive preview sizing.
    ...pickMediaDimensions(versions.cropped, versions.full),
    filenameHint: buildHighlightFilenameHint(entry, username),
  };
}

function getHighlightCoverVersions(entry: HighlightsTrayItem) {
  return {
    full: entry.cover_media.full_image_version ?? undefined,
    cropped: entry.cover_media.cropped_image_version ?? undefined,
  };
}

function buildHighlightFilenameHint(entry: HighlightsTrayItem, username: string): string {
  return `${username}_highlight_${slugifyTitle(entry.title) || 'untitled'}_${highlightIdTail(entry.id)}`;
}

function buildHighlightPreviewUrl(
  croppedUrl: string | undefined,
  downloadUrl: string
): string | undefined {
  return croppedUrl && croppedUrl !== downloadUrl ? croppedUrl : undefined;
}

function pickPreviewSrc(
  resources: readonly { src: string; config_width?: number }[],
  fallback?: string
): string | undefined {
  if (resources.length === 0) return fallback;
  const sorted = [...resources].sort((a, b) => (a.config_width ?? 0) - (b.config_width ?? 0));
  // prefer at least 320px wide so the tile doesn't look blurry
  const candidate = sorted.find(r => (r.config_width ?? 0) >= 320) ?? sorted[0];
  return candidate?.src ?? fallback;
}

function normalizeShortcodeMedia(candidate: ShortcodeNode | undefined): MediaItem[] {
  const items: MediaItem[] = [];
  if (!candidate) return items;

  const typename = candidate.__typename;
  const id = candidate.id != null ? String(candidate.id) : undefined;

  if (!isKnownShortcodeTypename(typename)) {
    console.warn('[GramGrab] unknown shortcode __typename:', typename);
    return items;
  }

  const node = candidate as ShortcodeVideo | ShortcodeImage | ShortcodeSidecar;
  const context = buildShortcodeMediaContext(node, typename, id);
  return collectShortcodeMediaItems(node, typename, context);
}

export const normalizeKnownShortcodeMedia = (
  candidate: ShortcodeNode | undefined
): Effect.Effect<MediaItem[], ResponseShapeUnknown> => {
  const items = normalizeShortcodeMedia(candidate);
  if (candidate && isKnownShortcodeTypename(candidate.__typename) && items.length === 0) {
    return Effect.fail(new ResponseShapeUnknown({ context: 'shortcode_media' }));
  }
  return Effect.succeed(items);
};

export function normalizeReelsMediaItems(reels: readonly ReelItem[]): MediaItem[] {
  return reels.flatMap(reel =>
    reel.items.flatMap(item => normalizeReelItem(String(reel.id), item))
  );
}

function isKnownShortcodeTypename(typename: string | undefined): boolean {
  return (
    SHORTCODE_VIDEO_TYPENAMES.has(typename ?? '') ||
    SHORTCODE_IMAGE_TYPENAMES.has(typename ?? '') ||
    SHORTCODE_SIDECAR_TYPENAMES.has(typename ?? '')
  );
}

function buildShortcodeMediaContext(
  node: ShortcodeVideo | ShortcodeImage | ShortcodeSidecar,
  typename: string | undefined,
  id: string | undefined
): MediaContext {
  return {
    takenAt: node.taken_at_timestamp,
    filenameHint: `${node.shortcode ?? id ?? 'media'}_${typename ?? 'media'}`,
  };
}

function createShortcodeMediaItem(
  context: MediaContext,
  url: string,
  type: 'image' | 'video',
  width?: number,
  height?: number,
  previewUrl?: string
): MediaItem {
  return {
    itemIndex: 0,
    type,
    url,
    previewUrl,
    width,
    height,
    takenAt: context.takenAt,
    filenameHint: context.filenameHint,
  };
}

function collectShortcodeMediaItems(
  node: ShortcodeVideo | ShortcodeImage | ShortcodeSidecar,
  typename: string | undefined,
  context: MediaContext
): MediaItem[] {
  if (SHORTCODE_SIDECAR_TYPENAMES.has(typename ?? '')) {
    return normalizeSidecarChildren(node as ShortcodeSidecar, context);
  }

  if (SHORTCODE_VIDEO_TYPENAMES.has(typename ?? '')) {
    const item = normalizeShortcodeVideoItem(node as ShortcodeVideo, context);
    return item ? [item] : [];
  }

  const item = normalizeShortcodeImageItem(node as ShortcodeImage, context);
  return item ? [item] : [];
}

function normalizeSidecarChildren(sidecar: ShortcodeSidecar, context: MediaContext): MediaItem[] {
  return (sidecar.edge_sidecar_to_children?.edges ?? []).flatMap(edge => {
    const item = edge.node.is_video
      ? normalizeSidecarVideoItem(edge.node, context)
      : normalizeSidecarImageItem(edge.node, context);
    return item ? [item] : [];
  });
}

function normalizeSidecarVideoItem(
  node: SidecarChild,
  context: MediaContext
): MediaItem | undefined {
  const mediaSource = resolveVideoMediaSource(
    node.video_resources ?? [],
    node.video_url,
    node.dimensions
  );
  return mediaSource
    ? {
        ...createShortcodeMediaItem(
          context,
          mediaSource.url,
          'video',
          mediaSource.width,
          mediaSource.height,
          pickPreviewSrc(node.display_resources ?? [], node.display_url)
        ),
        mediaId: node.id != null ? String(node.id) : undefined,
      }
    : undefined;
}

function normalizeSidecarImageItem(
  node: SidecarChild,
  context: MediaContext
): MediaItem | undefined {
  const item = createImageMediaItem(
    node.display_resources ?? [],
    node.display_url,
    node.dimensions,
    context
  );
  return item ? { ...item, mediaId: node.id != null ? String(node.id) : undefined } : undefined;
}

function normalizeShortcodeVideoItem(
  video: ShortcodeVideo,
  context: MediaContext
): MediaItem | undefined {
  const mediaSource = resolveVideoMediaSource(
    video.video_resources ?? [],
    video.video_url,
    video.dimensions
  );
  return mediaSource
    ? {
        ...createShortcodeMediaItem(
          context,
          mediaSource.url,
          'video',
          mediaSource.width,
          mediaSource.height,
          video.display_url
        ),
        mediaId: video.id != null ? String(video.id) : undefined,
      }
    : undefined;
}

function normalizeShortcodeImageItem(
  image: ShortcodeImage,
  context: MediaContext
): MediaItem | undefined {
  const item = createImageMediaItem(
    image.display_resources ?? [],
    image.display_url,
    image.dimensions,
    context
  );
  return item ? { ...item, mediaId: image.id != null ? String(image.id) : undefined } : undefined;
}

function resolveVideoMediaSource(
  resources: readonly { src: string; config_width?: number; config_height?: number }[],
  fallbackUrl: string | undefined,
  dims: MediaDimensions | undefined
): { url: string; width?: number; height?: number } | undefined {
  const bestUrl = pickBestResource(resources) ?? fallbackUrl;
  if (!bestUrl) return undefined;

  return {
    url: bestUrl,
    ...pickLargestResourceDimensions(resources, dims),
  };
}

function pickLargestResourceDimensions(
  resources: readonly { config_width?: number; config_height?: number }[],
  dims: MediaDimensions | undefined
): MediaDimensions {
  const largest = sortResourcesByWidth(resources)[0];
  return {
    width: largest?.config_width ?? dims?.width,
    height: largest?.config_height ?? dims?.height,
  };
}

function pickMediaDimensions(
  preferred: MediaDimensions | undefined,
  fallback: MediaDimensions | undefined
): MediaDimensions {
  return {
    width: preferred?.width ?? fallback?.width,
    height: preferred?.height ?? fallback?.height,
  };
}

function createImageMediaItem(
  resources: readonly { src: string; config_width?: number; config_height?: number }[],
  fallbackUrl: string | undefined,
  dims: MediaDimensions | undefined,
  context: MediaContext
): MediaItem | undefined {
  const bestUrl = pickBestResource(resources) ?? fallbackUrl;
  if (!bestUrl) return undefined;
  const size = pickLargestResourceDimensions(resources, dims);

  return createShortcodeMediaItem(
    context,
    bestUrl,
    'image',
    size.width,
    size.height,
    pickPreviewSrc(resources, fallbackUrl)
  );
}

function sortResourcesByWidth<T extends { config_width?: number; config_height?: number }>(
  resources: readonly T[]
): T[] {
  return [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0));
}

function normalizeReelItem(reelId: string, item: ReelItem['items'][number]): MediaItem[] {
  if (item.__typename === 'GraphStoryVideo') {
    const normalized = createStoryVideoItem(reelId, item as StoryVideoItem);
    return normalized ? [normalized] : [];
  }

  if (item.__typename === 'GraphStoryImage') {
    const normalized = createStoryImageItem(reelId, item as StoryImageItem);
    return normalized ? [normalized] : [];
  }

  console.warn('[GramGrab] unknown story item __typename:', item.__typename);
  return [];
}

function createStoryVideoItem(reelId: string, item: StoryVideoItem): MediaItem | undefined {
  const best = pickBestResource(item.video_resources);
  return best
    ? {
        itemIndex: 0,
        mediaId: String(item.id),
        type: 'video',
        url: best,
        previewUrl: pickPreviewSrc(item.display_resources, item.display_url),
        width: item.dimensions?.width,
        height: item.dimensions?.height,
        takenAt: item.taken_at_timestamp,
        filenameHint: `${reelId}_${item.id}`,
      }
    : undefined;
}

function createStoryImageItem(reelId: string, item: StoryImageItem): MediaItem | undefined {
  const best = pickBestResource(item.display_resources) ?? item.display_url;
  return best
    ? {
        itemIndex: 0,
        mediaId: String(item.id),
        type: 'image',
        url: best,
        previewUrl: pickPreviewSrc(item.display_resources, item.display_url),
        width: item.dimensions?.width,
        height: item.dimensions?.height,
        takenAt: item.taken_at_timestamp,
        filenameHint: `${reelId}_${item.id}`,
      }
    : undefined;
}

function sanitizedUsername(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return sanitized || 'instagram_user';
}

function validMediaUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function bestInstantImage(candidates: readonly { width: number; height: number; url: string }[]) {
  return candidates
    .filter(
      candidate => candidate.width > 0 && candidate.height > 0 && validMediaUrl(candidate.url)
    )
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function firstUniqueProgressiveVideo(
  candidates: readonly { width: number; height: number; url: string }[]
) {
  const seen = new Set<string>();
  return candidates.find(candidate => {
    if (!validMediaUrl(candidate.url) || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function instantFilename(username: string, mediaId: string, takenAt: number): string {
  return `${sanitizedUsername(username)}_instant_${takenAt}_${mediaId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function normalizeInstantPhoto(item: InstantPhoto): MediaItem | undefined {
  const image = bestInstantImage(item.image_versions2.candidates);
  if (!image) return undefined;
  const username = sanitizedUsername(item.user.username);
  return {
    itemIndex: 0,
    mediaId: item.id,
    type: 'image',
    url: image.url,
    width: image.width,
    height: image.height,
    takenAt: item.taken_at,
    filenameHint: instantFilename(username, item.id, item.taken_at),
    creatorUsername: username,
  };
}

function normalizeInstantVideo(
  item: InstantVideo
): Effect.Effect<MediaItem | undefined, MediaDashOnlyUnsupported> {
  const video = firstUniqueProgressiveVideo(item.video_versions ?? []);
  if (!video && item.video_dash_manifest)
    return Effect.fail(new MediaDashOnlyUnsupported({ mediaId: item.id }));
  if (!video) return Effect.succeed(undefined);
  const poster = bestInstantImage(item.image_versions2?.candidates ?? []);
  const username = sanitizedUsername(item.user.username);
  return Effect.succeed({
    itemIndex: 0,
    mediaId: item.id,
    type: 'video',
    url: video.url,
    ...(poster ? { previewUrl: poster.url } : {}),
    width: video.width,
    height: video.height,
    takenAt: item.taken_at,
    filenameHint: instantFilename(username, item.id, item.taken_at),
    creatorUsername: username,
  });
}

export const normalizeInstantItems = Effect.fn(function* (items: readonly InstantItem[]) {
  const normalized: MediaItem[] = [];
  for (const item of items) {
    if (!('media_type' in item)) {
      console.warn('[GramGrab] unknown Instant __typename:', item.__typename);
      continue;
    }
    const media =
      item.media_type === 1 ? normalizeInstantPhoto(item) : yield* normalizeInstantVideo(item);
    if (media) normalized.push(media);
  }
  return withItemIndexes(normalized);
});
