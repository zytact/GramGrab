import { Effect, Either, Schema } from 'effect';
import { browser } from './lib/browser.ts';
import { jsonToDataUrl } from './lib/data-url.ts';
import { runHandler } from './effect/runtime.ts';
import {
  fetchBlobAsDataUrl,
  fetchHdAvatarUser,
  fetchHighlightsTray,
  fetchReelsMedia,
  fetchWebProfileInfoUser,
  graphqlFetch as graphqlFetchEffect,
  graphqlPost as graphqlPostEffect,
} from './effect/instagram.ts';
import { ShortcodeMediaResponseSchema } from './effect/schemas.ts';
import type {
  HdAvatarUser,
  HighlightsTrayItem,
  ReelItem,
  ShortcodeImage,
  ShortcodeNode,
  ShortcodeSidecar,
  ShortcodeVideo,
  StoryImageItem,
  StoryVideoItem,
  WebProfileInfoUser,
} from './effect/schemas.ts';
import {
  BrowserDownloadFailed,
  GraphQLRequestFailed,
  HttpError,
  InvalidInstagramUrl,
  MediaNotFound,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
  UsernameUnresolved,
  formatError,
} from './effect/errors.ts';

const DOWNLOAD_CONCURRENCY = 3;

const OPERATIONS = {
  MEDIA_BY_SHORTCODE: {
    doc_id: '8845758582119845',
    apiUrl: 'https://www.instagram.com/api/graphql/',
    url: 'https://www.instagram.com/graphql/query/',
  },
  REELS_MEDIA: {
    query_hash: '45246d3fe16ccc6577e0bd297a5db1ab',
    url: 'https://www.instagram.com/graphql/query/',
  },
} as const;

const IG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-IG-App-ID': '936619743392459',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'cors',
  Referer: 'https://www.instagram.com/',
} as const;

const USER_PROFILE_URL = 'https://www.instagram.com/api/v1/users/web_profile_info/';
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

interface ParsedUrl {
  type: 'post' | 'reel' | 'story' | 'highlight' | 'profile';
  shortcode?: string;
  username?: string;
  highlightId?: string;
  carouselIndex?: number;
}

type SidecarChild = NonNullable<
  NonNullable<ShortcodeSidecar['edge_sidecar_to_children']>['edges']
>[number]['node'];
type ShortcodeMediaResponse = Schema.Schema.Type<typeof ShortcodeMediaResponseSchema>;

interface MediaContext {
  takenAt?: number;
  filenameHint: string;
}

interface MediaDimensions {
  width?: number;
  height?: number;
}

function parseInstagramUrl(url: string): ParsedUrl | null {
  try {
    const u = new URL(url);
    if (!isInstagramHostname(u.hostname)) return null;
    const path = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (path.length === 0) return null;
    return (
      parsePostUrl(path, u) ?? parseReelUrl(path) ?? parseStoriesUrl(path) ?? parseProfileUrl(path)
    );
  } catch {
    return null;
  }
}

function isInstagramHostname(hostname: string): boolean {
  return hostname === 'www.instagram.com' || hostname === 'instagram.com';
}

function parsePostUrl(path: string[], url: URL): ParsedUrl | null {
  const postIndex = path.indexOf('p');
  const shortcode = postIndex >= 0 ? path[postIndex + 1] : undefined;
  if (!shortcode) return null;

  return {
    type: 'post',
    shortcode,
    carouselIndex: parseCarouselIndex(url.searchParams.get('img_index')),
  };
}

function parseReelUrl(path: string[]): ParsedUrl | null {
  const reelIndex = path.indexOf('reel');
  const shortcode = reelIndex >= 0 ? path[reelIndex + 1] : undefined;
  return shortcode ? { type: 'reel', shortcode } : null;
}

function parseStoriesUrl(path: string[]): ParsedUrl | null {
  const storiesIndex = path.indexOf('stories');
  if (storiesIndex < 0) return null;

  if (path[storiesIndex + 1] === 'highlights' && path[storiesIndex + 2]) {
    return { type: 'highlight', highlightId: path[storiesIndex + 2] };
  }

  const username = path[storiesIndex + 1];
  return username ? { type: 'story', username } : null;
}

function parseProfileUrl(path: string[]): ParsedUrl | null {
  if (path.length !== 1) return null;
  const username = path[0];
  if (!username || RESERVED_PROFILE_PATHS.has(username)) return null;
  return { type: 'profile', username };
}

function parseCarouselIndex(imgIndex: string | null): number | undefined {
  if (!imgIndex) return undefined;
  const parsed = Number.parseInt(imgIndex, 10);
  return Number.isFinite(parsed) ? parsed - 1 : undefined;
}

async function resolveUsernameToId(username: string): Promise<string | null> {
  const url = `${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`;
  const user = await Effect.runPromise(
    fetchWebProfileInfoUser(url, 'include', {
      ...IG_HEADERS,
      Origin: 'https://www.instagram.com',
    }).pipe(
      Effect.tapError(err =>
        Effect.sync(() => {
          if (err._tag === 'ResponseShapeUnknown')
            console.warn('resolveUsernameToId: unexpected web_profile_info shape');
        })
      ),
      Effect.catchAll(() => Effect.succeed(undefined))
    )
  );
  const userId = user?.id ?? user?.pk;
  return userId != null ? String(userId) : null;
}

function pickBestResource(
  resources: readonly { src: string; config_width?: number }[]
): string | null {
  if (resources.length === 0) return null;
  return (
    [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0))[0]?.src ?? null
  );
}

interface MediaItem {
  type: 'image' | 'video';
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  takenAt?: number;
  filenameHint: string;
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

function normalizeProfilePicture(
  user: WebProfileInfoUser | undefined,
  username: string,
  hdUser?: HdAvatarUser
): MediaItem[] {
  // hd_profile_pic_url_info (1080px) > hd_profile_pic_versions > profile_pic_url_hd (320px)
  const picUrl = resolveHdUrl(hdUser) ?? user?.profile_pic_url_hd ?? user?.profile_pic_url;
  if (!picUrl) return [];
  return [
    {
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

function normalizeHighlightCovers(
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
    type: 'image',
    url: downloadUrl,
    previewUrl: buildHighlightPreviewUrl(versions.cropped?.url, downloadUrl),
    ...pickMediaDimensions(versions.full, versions.cropped),
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

function normalizeReelsMediaItems(reels: readonly ReelItem[]): MediaItem[] {
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
    ? createShortcodeMediaItem(
        context,
        mediaSource.url,
        'video',
        mediaSource.width,
        mediaSource.height,
        pickPreviewSrc(node.display_resources ?? [], node.display_url)
      )
    : undefined;
}

function normalizeSidecarImageItem(
  node: SidecarChild,
  context: MediaContext
): MediaItem | undefined {
  return createImageMediaItem(
    node.display_resources ?? [],
    node.display_url,
    node.dimensions,
    context
  );
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
    ? createShortcodeMediaItem(
        context,
        mediaSource.url,
        'video',
        mediaSource.width,
        mediaSource.height,
        video.display_url
      )
    : undefined;
}

function normalizeShortcodeImageItem(
  image: ShortcodeImage,
  context: MediaContext
): MediaItem | undefined {
  return createImageMediaItem(
    image.display_resources ?? [],
    image.display_url,
    image.dimensions,
    context
  );
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

// ---------------------------------------------------------------------------
// Shared Effect pipelines — parse → fetch → normalize
// ---------------------------------------------------------------------------

const IG_GRAPHQL_HEADERS = { ...IG_HEADERS, Origin: 'https://www.instagram.com' } as const;
const IG_API_GRAPHQL_HEADERS = {
  ...IG_GRAPHQL_HEADERS,
  Referer: 'https://www.instagram.com/',
} as const;

function resolveShortcodeResponseNode(decoded: ShortcodeMediaResponse) {
  return (
    decoded.data?.xdt_shortcode_media ??
    decoded.data?.shortcode_media ??
    decoded.data?.media ??
    decoded.xdt_shortcode_media ??
    decoded.shortcode_media ??
    decoded.media
  );
}

function decodeShortcodeResponse(raw: unknown) {
  return Schema.decodeUnknown(ShortcodeMediaResponseSchema)(raw).pipe(
    Effect.mapError(() => new ResponseShapeUnknown({ context: 'shortcode_media' }))
  );
}

function responseHasShortcodeNode(raw: Record<string, unknown>) {
  return decodeShortcodeResponse(raw).pipe(
    Effect.flatMap(decoded =>
      resolveShortcodeResponseNode(decoded)
        ? Effect.succeed(raw)
        : Effect.fail(new ResponseShapeUnknown({ context: 'shortcode_media' }))
    )
  );
}

const fetchShortcodeMediaRaw = (
  shortcode: string
): Effect.Effect<
  Record<string, unknown>,
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  graphqlFetchEffect(
    OPERATIONS.MEDIA_BY_SHORTCODE.url,
    'doc_id',
    OPERATIONS.MEDIA_BY_SHORTCODE.doc_id,
    { shortcode },
    IG_GRAPHQL_HEADERS
  ).pipe(
    Effect.flatMap(responseHasShortcodeNode),
    Effect.catchAll(err =>
      err._tag === 'RateLimited'
        ? Effect.fail(err)
        : graphqlPostEffect(
            OPERATIONS.MEDIA_BY_SHORTCODE.apiUrl,
            OPERATIONS.MEDIA_BY_SHORTCODE.doc_id,
            { shortcode },
            IG_API_GRAPHQL_HEADERS
          )
    )
  );

const fetchShortcodeMediaItems = (
  shortcode: string
): Effect.Effect<
  MediaItem[],
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  fetchShortcodeMediaRaw(shortcode).pipe(
    Effect.flatMap(decodeShortcodeResponse),
    Effect.map(resolveShortcodeResponseNode),
    Effect.map(normalizeShortcodeMedia)
  );

function createReelsRequestVariables(kind: 'highlight' | 'story', id: string) {
  return kind === 'highlight'
    ? {
        highlight_reel_ids: [id],
        reel_ids: [],
        location_ids: [],
        precomposed_overlay: false,
      }
    : {
        reel_ids: [id],
        highlight_reel_ids: [],
        location_ids: [],
        precomposed_overlay: false,
      };
}

const fetchHighlightMediaItems = (
  highlightId: string
): Effect.Effect<
  MediaItem[],
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  fetchReelsMedia(
    OPERATIONS.MEDIA_BY_SHORTCODE.url,
    'query_hash',
    OPERATIONS.REELS_MEDIA.query_hash,
    createReelsRequestVariables('highlight', highlightId),
    IG_GRAPHQL_HEADERS
  ).pipe(Effect.map(normalizeReelsMediaItems));

const fetchStoryMediaItems = (
  username: string
): Effect.Effect<
  MediaItem[],
  UsernameUnresolved | GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  Effect.gen(function* () {
    const userId = yield* Effect.tryPromise({
      try: () => resolveUsernameToId(username),
      catch: cause => new NetworkError({ cause }),
    });

    if (!userId) {
      return yield* Effect.fail(new UsernameUnresolved({ username }));
    }

    const reels = yield* fetchReelsMedia(
      OPERATIONS.MEDIA_BY_SHORTCODE.url,
      'query_hash',
      OPERATIONS.REELS_MEDIA.query_hash,
      createReelsRequestVariables('story', userId),
      IG_GRAPHQL_HEADERS
    );

    return normalizeReelsMediaItems(reels);
  });

function mapProfileRequestError(err: HttpError | NetworkError | ResponseShapeUnknown) {
  return err._tag === 'HttpError'
    ? new NetworkError({ cause: `Profile request failed: ${err.status} ${err.message}` })
    : err._tag === 'ResponseShapeUnknown'
      ? err
      : new NetworkError({ cause: err });
}

const fetchProfileMediaItems = (
  username: string
): Effect.Effect<MediaItem[], NetworkError | ResponseShapeUnknown> => {
  const profileInfoUrl = `${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`;

  return fetchWebProfileInfoUser(profileInfoUrl, 'omit', IG_GRAPHQL_HEADERS).pipe(
    Effect.mapError(mapProfileRequestError),
    Effect.flatMap(user => {
      const rawUserId = user?.id ?? user?.pk;
      const userId = rawUserId != null ? String(rawUserId) : undefined;
      const avatarEffect = userId
        ? fetchHdAvatarUser(userId, IG_HEADERS).pipe(
            Effect.map(hdUser => normalizeProfilePicture(user, username, hdUser))
          )
        : Effect.succeed(normalizeProfilePicture(user, username));
      const coversEffect = userId
        ? fetchHighlightsTray(userId, IG_GRAPHQL_HEADERS).pipe(
            Effect.map(tray => normalizeHighlightCovers(tray, username)),
            Effect.catchAll(err =>
              Effect.sync(() => {
                console.warn('highlights_tray failed:', err);
                return [] as MediaItem[];
              })
            )
          )
        : Effect.succeed([] as MediaItem[]);

      return Effect.all([avatarEffect, coversEffect], { concurrency: 'unbounded' }).pipe(
        Effect.map(([avatar, covers]) => [...avatar, ...covers])
      );
    })
  );
};

const resolveMediaEffect = (
  url: string
): Effect.Effect<
  MediaItem[],
  | InvalidInstagramUrl
  | UsernameUnresolved
  | NetworkError
  | GraphQLRequestFailed
  | RateLimited
  | ResponseShapeUnknown
> =>
  Effect.gen(function* () {
    const parsed = parseInstagramUrl(url);
    if (!parsed) return yield* Effect.fail(new InvalidInstagramUrl({ url }));

    switch (parsed.type) {
      case 'post':
      case 'reel':
        return yield* fetchShortcodeMediaItems(parsed.shortcode!);
      case 'highlight':
        return yield* fetchHighlightMediaItems(parsed.highlightId!);
      case 'story':
        return yield* fetchStoryMediaItems(parsed.username!);
      case 'profile':
        return yield* fetchProfileMediaItems(parsed.username!);
    }
  });

const downloadMediaEffect = (
  url: string,
  carouselIndex?: number
): Effect.Effect<
  { items: MediaItem[]; failures: { url: string; reason: string }[] },
  | InvalidInstagramUrl
  | UsernameUnresolved
  | NetworkError
  | GraphQLRequestFailed
  | RateLimited
  | ResponseShapeUnknown
  | MediaNotFound
> =>
  Effect.gen(function* () {
    const allItems = yield* resolveMediaEffect(url);

    let items = allItems;
    if (carouselIndex !== undefined && items[carouselIndex] !== undefined) {
      items = [items[carouselIndex]!];
    }

    if (items.length === 0) {
      return yield* Effect.fail(
        new MediaNotFound({
          hint: 'Instagram may have changed the response shape or the session is not authorized.',
        })
      );
    }

    const results = yield* Effect.forEach(
      items.map((item, i) => ({ item, i })),
      ({ item, i }) => {
        const ext = item.type === 'video' ? 'mp4' : 'jpg';
        const filename = `${item.filenameHint}_${i + 1}.${ext}`;
        return Effect.tryPromise({
          try: () => browser.downloads.download({ url: item.url, filename, saveAs: false }),
          catch: cause => new BrowserDownloadFailed({ url: item.url, cause }),
        }).pipe(
          Effect.map(() => item),
          Effect.either
        );
      },
      { concurrency: DOWNLOAD_CONCURRENCY }
    );

    const succeeded = results.flatMap(r => (Either.isRight(r) ? [r.right] : []));
    const failures = results.flatMap(r =>
      Either.isLeft(r) ? [{ url: r.left.url, reason: formatError(r.left) }] : []
    );

    return { items: succeeded, failures };
  });

// ---------------------------------------------------------------------------
// Handler functions — each returns a structured response value
// ---------------------------------------------------------------------------

interface DownloadMsg {
  type: 'DOWNLOAD';
  url: string;
  carouselIndex?: number;
}

async function handleDownload(msg: DownloadMsg): Promise<{
  media: MediaItem[] | undefined;
  failures: { url: string; reason: string }[] | undefined;
  error: string | undefined;
}> {
  return Effect.runPromise(
    downloadMediaEffect(msg.url, msg.carouselIndex).pipe(
      Effect.map(({ items, failures }) => {
        if (items.length === 0 && failures.length > 0) {
          return {
            media: undefined as MediaItem[] | undefined,
            failures,
            error: 'All downloads failed' as string | undefined,
          };
        }
        return {
          media: items as MediaItem[] | undefined,
          failures:
            failures.length > 0
              ? failures
              : (undefined as { url: string; reason: string }[] | undefined),
          error: undefined as string | undefined,
        };
      }),
      Effect.catchAll(err =>
        Effect.succeed({
          media: undefined as MediaItem[] | undefined,
          failures: undefined as { url: string; reason: string }[] | undefined,
          error: formatError(err) as string | undefined,
        })
      )
    )
  );
}

interface FetchMediaMsg {
  type: 'FETCH_MEDIA';
  url: string;
}

async function handleFetchMedia(msg: FetchMediaMsg): Promise<{
  media: { url: string; type: string; filenameHint: string; previewUrl?: string }[] | undefined;
  error: string | undefined;
}> {
  return runHandler(
    resolveMediaEffect(msg.url).pipe(
      Effect.map(items => ({
        media: items.map(item => ({
          url: item.url,
          type: item.type,
          filenameHint: item.filenameHint,
          previewUrl: item.previewUrl,
        })),
      }))
    ),
    { media: undefined }
  );
}

interface GetPreviewUrlMsg {
  type: 'GET_PREVIEW_URL';
  url: string;
}

async function handleGetPreviewUrl(
  msg: GetPreviewUrlMsg
): Promise<{ previewUrl: string | undefined; error: string | undefined }> {
  return runHandler(fetchBlobAsDataUrl(msg.url).pipe(Effect.map(previewUrl => ({ previewUrl }))), {
    previewUrl: undefined,
  });
}

interface DownloadMediaMsg {
  type: 'DOWNLOAD_MEDIA';
  urls: string[];
  hints: string[];
  types: string[];
}

interface FetchVideoBlobMsg {
  type: 'FETCH_VIDEO_BLOB';
  url: string;
}

async function handleDownloadMedia(
  msg: DownloadMediaMsg
): Promise<{ error: string | undefined; failures?: { url: string; reason: string }[] }> {
  const { urls, hints, types } = msg;
  const validItems = urls
    .map((url, i) => ({ url, hint: hints[i] ?? 'media', type: types[i] ?? 'image', index: i }))
    .filter(item => !!item.url);

  return Effect.runPromise(
    Effect.forEach(
      validItems,
      item => {
        const ext = item.type === 'video' ? 'mp4' : 'jpg';
        const filename = `${item.hint}_${item.index + 1}.${ext}`;
        return Effect.tryPromise({
          try: () => browser.downloads.download({ url: item.url, filename, saveAs: false }),
          catch: cause => new BrowserDownloadFailed({ url: item.url, cause }),
        }).pipe(Effect.either);
      },
      { concurrency: DOWNLOAD_CONCURRENCY }
    ).pipe(
      Effect.map(results => {
        const failures = results.flatMap(r =>
          Either.isLeft(r) ? [{ url: r.left.url, reason: formatError(r.left) }] : []
        );
        if (failures.length === results.length && results.length > 0) {
          return { error: 'All downloads failed' as string | undefined, failures };
        }
        return {
          error:
            failures.length > 0
              ? (`${results.length - failures.length} of ${results.length} downloads succeeded; ${failures.length} failed.` as
                  | string
                  | undefined)
              : undefined,
          failures: failures.length > 0 ? failures : undefined,
        };
      })
    )
  );
}

async function handleFetchVideoBlob(
  msg: FetchVideoBlobMsg
): Promise<{ dataUrl: string | undefined; error: string | undefined }> {
  return runHandler(fetchBlobAsDataUrl(msg.url).pipe(Effect.map(dataUrl => ({ dataUrl }))), {
    dataUrl: undefined,
  });
}

interface DebugShapeMsg {
  type: 'DEBUG_SHAPE';
  url?: string;
}

async function handleDebugShape(msg: DebugShapeMsg): Promise<{ raw?: unknown; error?: string }> {
  const parsed = parseInstagramUrl(msg.url ?? '');
  if (!parsed || (parsed.type !== 'post' && parsed.type !== 'reel')) {
    return { error: 'Use a post or reel URL for debug' };
  }
  return Effect.runPromise(
    fetchShortcodeMediaRaw(parsed.shortcode!).pipe(
      Effect.map(raw => ({ raw })),
      Effect.catchAll(err => Effect.succeed({ error: formatError(err) }))
    )
  );
}

interface DownloadDebugJsonMsg {
  type: 'DOWNLOAD_DEBUG_JSON';
  json?: unknown;
}

async function handleDownloadDebugJson(
  msg: DownloadDebugJsonMsg
): Promise<{ error: string | undefined }> {
  if (!msg.json) {
    return { error: 'No debug JSON available' };
  }
  try {
    // Use jsonToDataUrl — avoids URL.createObjectURL which is unavailable in
    // Chromium MV3 service workers.
    const url = jsonToDataUrl(msg.json);
    await browser.downloads.download({
      url,
      filename: `gramgrab-debug-${Date.now()}.json`,
      saveAs: true,
    });
    return { error: undefined };
  } catch (err) {
    return { error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Single message dispatcher
//
// All listeners are registered synchronously at module top-level so they are
// available immediately when the service worker starts.
//
// We use `sendResponse` + `return true` instead of returning a Promise from
// the listener. This is the cross-browser-safe pattern: Chrome's MV3 docs
// still recommend it, and Firefox supports it alongside promise-return style.
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const m = msg as { type?: string };

  switch (m.type) {
    case 'DOWNLOAD':
      void handleDownload(msg as DownloadMsg).then(sendResponse);
      return true;

    case 'FETCH_MEDIA':
      void handleFetchMedia(msg as FetchMediaMsg).then(sendResponse);
      return true;

    case 'GET_PREVIEW_URL':
      void handleGetPreviewUrl(msg as GetPreviewUrlMsg).then(sendResponse);
      return true;

    case 'DOWNLOAD_MEDIA':
      void handleDownloadMedia(msg as DownloadMediaMsg).then(sendResponse);
      return true;

    case 'FETCH_VIDEO_BLOB':
      void handleFetchVideoBlob(msg as FetchVideoBlobMsg).then(sendResponse);
      return true;

    case 'DEBUG_SHAPE':
      void handleDebugShape(msg as DebugShapeMsg).then(sendResponse);
      return true;

    case 'DOWNLOAD_DEBUG_JSON':
      void handleDownloadDebugJson(msg as DownloadDebugJsonMsg).then(sendResponse);
      return true;

    default:
      return false;
  }
});
