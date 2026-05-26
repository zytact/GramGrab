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

interface ParsedUrl {
  type: 'post' | 'reel' | 'story' | 'highlight' | 'profile';
  shortcode?: string;
  username?: string;
  highlightId?: string;
  carouselIndex?: number;
}

function parseInstagramUrl(url: string): ParsedUrl | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.instagram.com' && u.hostname !== 'instagram.com') return null;
    const path = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (path.length === 0) return null;
    const postIndex = path.indexOf('p');
    if (postIndex >= 0 && path[postIndex + 1]) {
      return {
        type: 'post',
        shortcode: path[postIndex + 1],
        carouselIndex: u.searchParams.has('img_index')
          ? parseInt(u.searchParams.get('img_index')!) - 1
          : undefined,
      };
    }
    const reelIndex = path.indexOf('reel');
    if (reelIndex >= 0 && path[reelIndex + 1]) {
      return { type: 'reel', shortcode: path[reelIndex + 1] };
    }
    const storiesIndex = path.indexOf('stories');
    if (storiesIndex >= 0) {
      if (path[storiesIndex + 1] === 'highlights' && path[storiesIndex + 2]) {
        return { type: 'highlight', highlightId: path[storiesIndex + 2] };
      }
      if (path[storiesIndex + 1]) {
        return { type: 'story', username: path[storiesIndex + 1] };
      }
    }
    if (path.length === 1) {
      const username = path[0];
      const reserved = new Set([
        'p',
        'reel',
        'reels',
        'stories',
        'explore',
        'direct',
        'accounts',
        'tv',
      ]);
      if (username && !reserved.has(username)) {
        return { type: 'profile', username };
      }
    }
    return null;
  } catch {
    return null;
  }
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
  const items: MediaItem[] = [];
  for (const entry of tray) {
    const full = entry.cover_media.full_image_version ?? undefined;
    const cropped = entry.cover_media.cropped_image_version ?? undefined;
    const downloadUrl = full?.url ?? cropped?.url;
    if (!downloadUrl) continue;
    const preview = cropped?.url && cropped.url !== downloadUrl ? cropped.url : undefined;
    const dims = full ?? cropped;
    const slug = slugifyTitle(entry.title) || 'untitled';
    const tail = highlightIdTail(entry.id);
    items.push({
      type: 'image',
      url: downloadUrl,
      previewUrl: preview,
      width: dims?.width,
      height: dims?.height,
      filenameHint: `${username}_highlight_${slug}_${tail}`,
    });
  }
  return items;
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

  // Unknown passthrough — log and skip
  if (
    typename !== 'XDTGraphVideo' &&
    typename !== 'GraphVideo' &&
    typename !== 'Video' &&
    typename !== 'XDTMediaVideo' &&
    typename !== 'ClipsShareVideo' &&
    typename !== 'XDTGraphImage' &&
    typename !== 'GraphImage' &&
    typename !== 'Image' &&
    typename !== 'XDTMediaImage' &&
    typename !== 'XDTGraphSidecar' &&
    typename !== 'GraphSidecar' &&
    typename !== 'Sidecar' &&
    typename !== 'XDTMediaAlbum'
  ) {
    console.warn('[GramGrab] unknown shortcode __typename:', typename);
    return items;
  }

  // TypeScript now narrows candidate to Video | Image | Sidecar
  const node = candidate as ShortcodeVideo | ShortcodeImage | ShortcodeSidecar;

  const shortcode = node.shortcode;
  const takenAt = node.taken_at_timestamp;
  const hint = `${shortcode ?? id ?? 'media'}_${typename ?? 'media'}`;

  const push = (url: string, type: 'image' | 'video', w?: number, h?: number, preview?: string) =>
    items.push({
      type,
      url,
      previewUrl: preview,
      width: w,
      height: h,
      takenAt,
      filenameHint: hint,
    });

  if (
    typename === 'XDTGraphSidecar' ||
    typename === 'GraphSidecar' ||
    typename === 'Sidecar' ||
    typename === 'XDTMediaAlbum'
  ) {
    const sidecar = node as ShortcodeSidecar;
    sidecar.edge_sidecar_to_children?.edges?.forEach(edge => {
      const n = edge.node;
      const displayResources = n.display_resources ?? [];
      const displayUrl = n.display_url;
      const isChildVideo = n.is_video === true;
      const dims = n.dimensions;

      if (isChildVideo) {
        const videoResources = n.video_resources ?? [];
        const bestVideo = pickBestResource(videoResources) ?? n.video_url;
        const preview = pickPreviewSrc(displayResources, displayUrl);
        if (bestVideo) {
          const sortedV = [...videoResources].sort(
            (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
          );
          push(
            bestVideo,
            'video',
            sortedV[0]?.config_width ?? dims?.width,
            sortedV[0]?.config_height ?? dims?.height,
            preview
          );
        }
        return;
      }

      if (displayResources.length > 0) {
        const sorted = [...displayResources].sort(
          (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
        );
        const best = sorted[0]?.src;
        const preview = pickPreviewSrc(displayResources, displayUrl);
        if (best) push(best, 'image', sorted[0]?.config_width, sorted[0]?.config_height, preview);
      } else if (displayUrl) {
        push(displayUrl, 'image', dims?.width, dims?.height);
      }
    });
  } else if (
    typename === 'XDTGraphVideo' ||
    typename === 'GraphVideo' ||
    typename === 'Video' ||
    typename === 'XDTMediaVideo' ||
    typename === 'ClipsShareVideo'
  ) {
    const video = node as ShortcodeVideo;
    const resources = video.video_resources ?? [];
    const best = pickBestResource(resources) ?? video.video_url;
    const dims = video.dimensions;
    const preview = video.display_url;
    if (best) {
      const sorted = [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0));
      push(
        best,
        'video',
        sorted[0]?.config_width ?? dims?.width,
        sorted[0]?.config_height ?? dims?.height,
        preview
      );
    }
  } else {
    // Image
    const image = node as ShortcodeImage;
    const displayResources = image.display_resources ?? [];
    const displayUrl = image.display_url;
    const dims = image.dimensions;

    if (displayResources.length > 0) {
      const sorted = [...displayResources].sort(
        (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
      );
      const best = sorted[0]?.src;
      const preview = pickPreviewSrc(displayResources, displayUrl);
      if (best) push(best, 'image', sorted[0]?.config_width, sorted[0]?.config_height, preview);
    } else if (displayUrl) {
      push(displayUrl, 'image', dims?.width, dims?.height);
    }
  }

  return items;
}

function normalizeReelsMediaItems(reels: readonly ReelItem[]): MediaItem[] {
  const items: MediaItem[] = [];

  for (const reel of reels) {
    const reelId = String(reel.id);
    for (const item of reel.items) {
      const typename = item.__typename;

      if (typename === 'GraphStoryVideo') {
        const v = item as StoryVideoItem;
        const best = pickBestResource(v.video_resources);
        if (!best) continue;
        const preview = pickPreviewSrc(v.display_resources, v.display_url);
        items.push({
          type: 'video',
          url: best,
          previewUrl: preview,
          width: v.dimensions?.width,
          height: v.dimensions?.height,
          takenAt: v.taken_at_timestamp,
          filenameHint: `${reelId}_${v.id}`,
        });
      } else if (typename === 'GraphStoryImage') {
        const img = item as StoryImageItem;
        const displayResources = img.display_resources;
        const best =
          displayResources.length > 0
            ? [...displayResources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0))[0]
                ?.src
            : img.display_url;
        if (!best) continue;
        const preview = pickPreviewSrc(displayResources, img.display_url);
        items.push({
          type: 'image',
          url: best,
          previewUrl: preview,
          width: img.dimensions?.width,
          height: img.dimensions?.height,
          takenAt: img.taken_at_timestamp,
          filenameHint: `${reelId}_${img.id}`,
        });
      } else {
        // Unknown story type — skip and log so we know to update the schema
        console.warn('[GramGrab] unknown story item __typename:', typename);
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Shared Effect pipelines — parse → fetch → normalize
// ---------------------------------------------------------------------------

const IG_GRAPHQL_HEADERS = { ...IG_HEADERS, Origin: 'https://www.instagram.com' } as const;

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

    if (parsed.type === 'post' || parsed.type === 'reel') {
      const raw = yield* graphqlFetchEffect(
        OPERATIONS.MEDIA_BY_SHORTCODE.url,
        'doc_id',
        OPERATIONS.MEDIA_BY_SHORTCODE.doc_id,
        { shortcode: parsed.shortcode! },
        IG_GRAPHQL_HEADERS
      );
      const decoded = yield* Schema.decodeUnknown(ShortcodeMediaResponseSchema)(raw).pipe(
        Effect.mapError(() => new ResponseShapeUnknown({ context: 'shortcode_media' }))
      );
      const node =
        decoded.data?.xdt_shortcode_media ??
        decoded.data?.shortcode_media ??
        decoded.data?.media ??
        decoded.xdt_shortcode_media ??
        decoded.shortcode_media ??
        decoded.media;
      return normalizeShortcodeMedia(node);
    }

    if (parsed.type === 'highlight') {
      const reels = yield* fetchReelsMedia(
        OPERATIONS.MEDIA_BY_SHORTCODE.url,
        'query_hash',
        OPERATIONS.REELS_MEDIA.query_hash,
        {
          highlight_reel_ids: [parsed.highlightId!],
          reel_ids: [],
          location_ids: [],
          precomposed_overlay: false,
        },
        IG_GRAPHQL_HEADERS
      );
      return normalizeReelsMediaItems(reels);
    }

    if (parsed.type === 'story') {
      const userId = yield* Effect.tryPromise({
        try: () => resolveUsernameToId(parsed.username!),
        catch: cause => new NetworkError({ cause }),
      });
      if (!userId)
        return yield* Effect.fail(new UsernameUnresolved({ username: parsed.username! }));
      const reels = yield* fetchReelsMedia(
        OPERATIONS.MEDIA_BY_SHORTCODE.url,
        'query_hash',
        OPERATIONS.REELS_MEDIA.query_hash,
        {
          reel_ids: [userId],
          highlight_reel_ids: [],
          location_ids: [],
          precomposed_overlay: false,
        },
        IG_GRAPHQL_HEADERS
      );
      return normalizeReelsMediaItems(reels);
    }

    // profile: one web_profile_info call shared between avatar + highlight covers
    const username = parsed.username!;
    const profileInfoUrl = `${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`;
    const user = yield* fetchWebProfileInfoUser(profileInfoUrl, 'omit', IG_GRAPHQL_HEADERS).pipe(
      Effect.mapError(err =>
        err._tag === 'HttpError'
          ? new NetworkError({ cause: `Profile request failed: ${err.status} ${err.message}` })
          : err._tag === 'ResponseShapeUnknown'
            ? err
            : new NetworkError({ cause: err })
      )
    );
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

    const [avatar, covers] = yield* Effect.all([avatarEffect, coversEffect], {
      concurrency: 'unbounded',
    });
    return [...avatar, ...covers];
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
    graphqlFetchEffect(
      OPERATIONS.MEDIA_BY_SHORTCODE.url,
      'doc_id',
      OPERATIONS.MEDIA_BY_SHORTCODE.doc_id,
      { shortcode: parsed.shortcode! },
      IG_GRAPHQL_HEADERS
    ).pipe(
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
      handleDownload(msg as DownloadMsg).then(sendResponse);
      return true;

    case 'FETCH_MEDIA':
      handleFetchMedia(msg as FetchMediaMsg).then(sendResponse);
      return true;

    case 'GET_PREVIEW_URL':
      handleGetPreviewUrl(msg as GetPreviewUrlMsg).then(sendResponse);
      return true;

    case 'DOWNLOAD_MEDIA':
      handleDownloadMedia(msg as DownloadMediaMsg).then(sendResponse);
      return true;

    case 'FETCH_VIDEO_BLOB':
      handleFetchVideoBlob(msg as FetchVideoBlobMsg).then(sendResponse);
      return true;

    case 'DEBUG_SHAPE':
      handleDebugShape(msg as DebugShapeMsg).then(sendResponse);
      return true;

    case 'DOWNLOAD_DEBUG_JSON':
      handleDownloadDebugJson(msg as DownloadDebugJsonMsg).then(sendResponse);
      return true;

    default:
      return false;
  }
});
