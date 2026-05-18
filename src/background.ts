import { Effect, Schema } from 'effect';
import { browser } from './lib/browser.ts';
import { jsonToDataUrl } from './lib/data-url.ts';
import { runHandler } from './effect/runtime.ts';
import {
  fetchBlobAsDataUrl,
  fetchWebProfileInfoUser,
  graphqlFetch as graphqlFetchEffect,
} from './effect/instagram.ts';
import { ShortcodeMediaResponseSchema } from './effect/schemas.ts';
import type { ShortcodeNode } from './effect/schemas.ts';
import type { WebProfileInfoUser } from './effect/schemas.ts';
import {
  BrowserDownloadFailed,
  GraphQLRequestFailed,
  InvalidInstagramUrl,
  MediaNotFound,
  NetworkError,
  ResponseShapeUnknown,
  UsernameUnresolved,
  formatError,
} from './effect/errors.ts';

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

function pickBestVideoResource(resources: { src: string; config_width?: number }[]): string | null {
  if (!resources || resources.length === 0) return null;
  return (
    [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0))[0]?.src ?? null
  );
}

function extractMediaUrls(node: Record<string, unknown>): {
  displayUrl?: string;
  videoUrl?: string;
  videoResources?: { src: string; config_width?: number }[];
} {
  return {
    displayUrl: (node.display_url as string | undefined) ?? (node.uri as string | undefined),
    videoUrl: node.video_url as string | undefined,
    videoResources: node.video_resources as { src: string; config_width?: number }[] | undefined,
  };
}

function unwrapData(data: unknown): Record<string, unknown> {
  const root = data as Record<string, unknown> | undefined;
  return (root?.data as Record<string, unknown>) ?? root ?? {};
}

function findArrayCandidates(root: unknown): unknown[] {
  const seen = new Set<object>();
  const out: unknown[] = [];
  const stack = [root as unknown];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);

    if (Array.isArray(cur)) {
      out.push(cur);
      for (const item of cur) stack.push(item);
      continue;
    }

    for (const value of Object.values(cur as Record<string, unknown>)) stack.push(value);
  }

  return out;
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

function normalizeProfilePicture(
  user: WebProfileInfoUser | undefined,
  username: string,
  hdUrl?: string
): MediaItem[] {
  // Prefer the full-res HD URL from the /users/{id}/info/ endpoint when available,
  // then fall back to profile_pic_url_hd (320x320) from web_profile_info.
  const picUrl = hdUrl ?? user?.profile_pic_url_hd ?? user?.profile_pic_url;
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

async function fetchProfilePicture(username: string): Promise<MediaItem[]> {
  const url = `${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`;

  // Step 1: fetch web_profile_info for basic profile data + fallback pic URL
  const profileUser = await Effect.runPromise(
    fetchWebProfileInfoUser(url, 'omit', {
      ...IG_HEADERS,
      Origin: 'https://www.instagram.com',
    }).pipe(
      Effect.mapError(err =>
        err._tag === 'HttpError'
          ? new Error(`Profile request failed: ${err.status} ${err.message}`)
          : new Error(String(err))
      )
    )
  );

  // Extract user ID so we can fetch the full-resolution picture
  const userId = profileUser?.id ?? profileUser?.pk;

  // Step 2: fetch full-res profile pic via the private user-info endpoint.
  // This requires an active Instagram session (credentials: 'include') but gracefully
  // falls back to the 320x320 profile_pic_url_hd when not logged in or on error.
  let hdUrl: string | undefined;
  if (userId) {
    try {
      const infoRes = await fetch(`https://i.instagram.com/api/v1/users/${userId}/info/`, {
        credentials: 'include',
        headers: { ...IG_HEADERS, Origin: 'https://www.instagram.com' },
      });
      if (infoRes.ok) {
        const infoData = (await infoRes.json()) as Record<string, unknown>;
        const infoUser = infoData?.user as Record<string, unknown> | undefined;
        hdUrl = (infoUser?.hd_profile_pic_url_info as Record<string, unknown> | undefined)?.url as
          | string
          | undefined;
      }
    } catch {
      // fall through to fallback
    }
  }

  return normalizeProfilePicture(profileUser, username, hdUrl);
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
  const isSidecar =
    typename === 'XDTGraphSidecar' || typename === 'GraphSidecar' || typename === 'Sidecar';
  const isVideo =
    typename === 'XDTGraphVideo' || typename === 'GraphVideo' || candidate.is_video === true;
  const isImage =
    typename === 'XDTGraphImage' ||
    typename === 'GraphImage' ||
    typename === 'Image' ||
    (!isVideo && !isSidecar);
  const shortcode = candidate.shortcode;
  const takenAt = candidate.taken_at_timestamp;
  const id = candidate.id != null ? String(candidate.id) : undefined;

  const push = (url: string, type: 'image' | 'video', w?: number, h?: number, preview?: string) =>
    items.push({
      type,
      url,
      previewUrl: preview,
      width: w,
      height: h,
      takenAt,
      filenameHint: `${shortcode ?? id ?? 'media'}_${typename ?? type}`,
    });

  if (isSidecar) {
    candidate.edge_sidecar_to_children?.edges?.forEach(edge => {
      const n = edge.node;
      const displayResources = n.display_resources;
      const displayUrl = n.display_url;
      const isChildVideo = n.is_video === true;
      const dims = n.dimensions;

      if (displayResources && displayResources.length > 0) {
        const sorted = [...displayResources].sort(
          (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
        );
        const best = sorted[0]?.src;
        const preview = isChildVideo ? n.display_url : pickPreviewSrc(displayResources, displayUrl);
        if (best) {
          push(
            best,
            isChildVideo ? 'video' : 'image',
            sorted[0]?.config_width,
            sorted[0]?.config_height,
            preview
          );
        }
      } else if (displayUrl) {
        push(displayUrl, isChildVideo ? 'video' : 'image', dims?.width, dims?.height);
      }
    });
  } else if (isVideo) {
    const videoResources = candidate.video_resources;
    const videoUrl = candidate.video_url;
    const dims = candidate.dimensions;
    const videoDisplayUrl = candidate.display_url;

    if (videoResources && videoResources.length > 0) {
      const sorted = [...videoResources].sort(
        (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
      );
      const best = sorted[0]?.src;
      if (best)
        push(best, 'video', sorted[0]?.config_width, sorted[0]?.config_height, videoDisplayUrl);
    } else if (videoUrl) {
      push(videoUrl, 'video', dims?.width, dims?.height, videoDisplayUrl);
    }
  } else if (isImage) {
    const displayResources = candidate.display_resources;
    const displayUrl = candidate.display_url;
    const dims = candidate.dimensions;

    if (displayResources && displayResources.length > 0) {
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

function normalizeReelsMedia(data: unknown): MediaItem[] {
  const items: MediaItem[] = [];
  const root = unwrapData(data);
  const reels =
    (root.reels_media as { id?: string; items?: Record<string, unknown>[] }[] | undefined) ??
    (root.reels as { id?: string; items?: Record<string, unknown>[] }[] | undefined);
  const candidateReels =
    reels ??
    (findArrayCandidates(root).find(arr => {
      return (
        Array.isArray(arr) &&
        arr.some(item => {
          const obj = item as Record<string, unknown>;
          return (
            !!obj &&
            typeof obj === 'object' &&
            (Array.isArray(obj.items) ||
              typeof obj.display_url === 'string' ||
              typeof obj.video_url === 'string')
          );
        })
      );
    }) as { id?: string; items?: Record<string, unknown>[] }[] | undefined);
  if (!candidateReels) return items;

  for (const reel of candidateReels) {
    const reelId = reel.id ?? 'reel';
    for (const item of reel.items ?? []) {
      const { displayUrl, videoUrl, videoResources } = extractMediaUrls(item);
      const isVid = (item.is_video as boolean | undefined) ?? false;
      const takenAt = item.taken_at_timestamp as number | undefined;
      const itemId = item.id as string | undefined;
      const dims = item.dimensions as { width?: number; height?: number } | undefined;

      const push = (url: string, type: 'image' | 'video', w?: number, h?: number) =>
        items.push({
          type,
          url,
          width: w,
          height: h,
          takenAt,
          filenameHint: `${reelId}_${itemId ?? 'item'}`,
        });

      if (isVid) {
        const best = pickBestVideoResource(videoResources ?? []) ?? videoUrl;
        if (best) push(best, 'video', dims?.width, dims?.height);
      } else if (displayUrl) {
        push(displayUrl, 'image', dims?.width, dims?.height);
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
      const raw = yield* graphqlFetchEffect(
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
      return normalizeReelsMedia(raw);
    }

    if (parsed.type === 'story') {
      const userId = yield* Effect.tryPromise({
        try: () => resolveUsernameToId(parsed.username!),
        catch: cause => new NetworkError({ cause }),
      });
      if (!userId)
        return yield* Effect.fail(new UsernameUnresolved({ username: parsed.username! }));
      const raw = yield* graphqlFetchEffect(
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
      return normalizeReelsMedia(raw);
    }

    // profile
    return yield* Effect.tryPromise({
      try: () => fetchProfilePicture(parsed.username!),
      catch: cause => new NetworkError({ cause }),
    });
  });

const downloadMediaEffect = (
  url: string,
  carouselIndex?: number
): Effect.Effect<
  MediaItem[],
  | InvalidInstagramUrl
  | UsernameUnresolved
  | NetworkError
  | GraphQLRequestFailed
  | ResponseShapeUnknown
  | MediaNotFound
  | BrowserDownloadFailed
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

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const ext = item.type === 'video' ? 'mp4' : 'jpg';
      const filename = `${item.filenameHint}_${i + 1}.${ext}`;
      yield* Effect.tryPromise({
        try: () => browser.downloads.download({ url: item.url, filename, saveAs: false }),
        catch: cause => new BrowserDownloadFailed({ url: item.url, cause }),
      });
    }

    return items;
  });

// ---------------------------------------------------------------------------
// Handler functions — each returns a structured response value
// ---------------------------------------------------------------------------

interface DownloadMsg {
  type: 'DOWNLOAD';
  url: string;
  carouselIndex?: number;
}

async function handleDownload(
  msg: DownloadMsg
): Promise<{ media: MediaItem[] | undefined; error: string | undefined }> {
  return runHandler(
    downloadMediaEffect(msg.url, msg.carouselIndex).pipe(Effect.map(media => ({ media }))),
    { media: undefined }
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

async function handleDownloadMedia(msg: DownloadMediaMsg): Promise<{ error: string | undefined }> {
  try {
    const { urls, hints, types } = msg;
    for (let i = 0; i < urls.length; i++) {
      const ext = types[i] === 'video' ? 'mp4' : 'jpg';
      const url = urls[i];
      const hint = hints[i] ?? 'media';
      if (!url) continue;
      const filename = `${hint}_${i + 1}.${ext}`;
      await browser.downloads.download({ url, filename, saveAs: false });
    }
    return { error: undefined };
  } catch (err) {
    return { error: String(err) };
  }
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
