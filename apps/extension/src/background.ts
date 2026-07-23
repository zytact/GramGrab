import { Effect, Schema } from 'effect';
import { browser } from './lib/browser.ts';
import { startNativeBridge } from './native-bridge.ts';
import {
  Completed,
  CommandResult,
  DebugExportResult,
  DebugGetResult,
  Export as ProtocolExport,
  ExportOperation as ProtocolExportOperation,
  ExportResult as ProtocolExportResult,
  FrameExport,
  HistoryClearResult,
  HistoryEntry as ProtocolHistoryEntry,
  HistoryListResult,
  HistoryMarker as ProtocolHistoryMarker,
  HistoryRedownloadFailed,
  HistoryRedownloadResult,
  HistoryRedownloadStarted,
  HistoryRemoveResult,
  HumanItemNumber,
  InspectResult,
  InspectedMedia,
  InternalItemIndex,
  ItemFailed,
  ItemSucceeded,
  MediaIdentity,
  OperationFailure as ProtocolOperationFailure,
  OperationId as ProtocolOperationId,
  Progress,
  Rejected,
  SilentExport,
  ValidationFailure,
  type EventPayload,
  type Request,
} from '@gramgrab/protocol';
import {
  canonicalizeInstagramUrl,
  WORKSPACE_TRANSFER_TTL_MS,
  type InstagramTarget,
  type WorkspaceSnapshot,
} from './workspace/contracts.ts';
import { replaceWorkspace } from './workspace/coordinator.ts';
import { historySource } from './history/source.ts';
import { reconcileHistoryEntry } from './history/reconciliation.ts';
import { appendHistory, clearHistory, getHistory, removeHistory } from './history/repository.ts';
import type { DownloadHistoryEntry, HistoryMarker } from './history/contracts.ts';
import { jsonToDataUrl } from './lib/data-url.ts';
import { runHandler, runOperationHandler } from './effect/runtime.ts';
import {
  protocolConfig,
  type ProtocolCandidate,
  type ProtocolOperation,
  type ProtocolRequest,
} from './instagram-protocol/config.ts';
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
import {
  DownloadAcceptedResult,
  DownloadFailedResult,
  DownloadMediaResponse,
  createOperationId,
  createRequestId,
  decodeDownloadMediaRequest,
  type DownloadMediaRequest,
  type DownloadOperation,
  type DownloadOperationResult,
} from './download/contracts.ts';
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
  GraphQLRequestFailed,
  HttpError,
  InvalidInstagramUrl,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
  UsernameUnresolved,
  formatError,
} from './effect/errors.ts';
import { OperationFailure, OperationWarning } from './errors/contracts.ts';
import { normalizeBrowserDownloadFailure, normalizeSourceFailure } from './errors/normalize.ts';

const DOWNLOAD_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index]!, index);
      }
    })
  );
  return results;
}

const IG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'X-IG-App-ID': protocolConfig.client.appId,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Mode': 'cors',
  Referer: 'https://www.instagram.com/',
} as const;

const USER_PROFILE_URL = 'https://www.instagram.com/api/v1/users/web_profile_info/';
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

type ParsedUrl = InstagramTarget;

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
  return canonicalizeInstagramUrl(url)?.target ?? null;
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
  itemIndex: number;
  mediaId?: string;
  type: 'image' | 'video';
  url: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  takenAt?: number;
  filenameHint: string;
}

function withItemIndexes(items: MediaItem[]): MediaItem[] {
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

const normalizeKnownShortcodeMedia = (
  candidate: ShortcodeNode | undefined
): Effect.Effect<MediaItem[], ResponseShapeUnknown> => {
  const items = normalizeShortcodeMedia(candidate);
  if (candidate && isKnownShortcodeTypename(candidate.__typename) && items.length === 0) {
    return Effect.fail(new ResponseShapeUnknown({ context: 'shortcode_media' }));
  }
  return Effect.succeed(items);
};

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

// ---------------------------------------------------------------------------
// Shared Effect pipelines — parse → fetch → normalize
// ---------------------------------------------------------------------------

const IG_GRAPHQL_HEADERS = { ...IG_HEADERS, Origin: 'https://www.instagram.com' } as const;
const IG_API_GRAPHQL_HEADERS = {
  ...IG_GRAPHQL_HEADERS,
  Referer: 'https://www.instagram.com/',
  'X-ASBD-ID': protocolConfig.client.asbdId,
} as const;

function configuredGraphqlHeaders(request: ProtocolRequest): Record<string, string> {
  return {
    ...(request.transport === 'form' ? IG_API_GRAPHQL_HEADERS : IG_GRAPHQL_HEADERS),
  };
}

function configuredRequests(operation: ProtocolOperation) {
  return operation.candidates.flatMap(candidate =>
    candidate.requests.map(request => ({ candidate, request }))
  );
}

function configuredGraphqlRequest(
  candidate: ProtocolCandidate,
  request: ProtocolRequest,
  variables: Record<string, unknown>
) {
  const headers = configuredGraphqlHeaders(request);
  return request.transport === 'form'
    ? graphqlPostEffect(request.endpoint, candidate.id, variables, headers, candidate.kind)
    : graphqlFetchEffect(request.endpoint, candidate.kind, candidate.id, variables, headers);
}

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

type ShortcodeFetchAttempt =
  | { readonly _tag: 'Found'; readonly raw: Record<string, unknown> }
  | { readonly _tag: 'Missing'; readonly raw: Record<string, unknown> }
  | {
      readonly _tag: 'Failed';
      readonly error: GraphQLRequestFailed | NetworkError | ResponseShapeUnknown;
    };

interface ShortcodeAttemptState {
  lastError?: GraphQLRequestFailed | NetworkError | ResponseShapeUnknown;
  lastRawWithoutNode?: Record<string, unknown>;
}

function rememberShortcodeAttempt(
  state: ShortcodeAttemptState,
  result: Exclude<ShortcodeFetchAttempt, { readonly _tag: 'Found' }>
): void {
  if (result._tag === 'Missing') state.lastRawWithoutNode = result.raw;
  else state.lastError = result.error;
}

const classifyShortcodeRaw = (raw: Record<string, unknown>) =>
  decodeShortcodeResponse(raw).pipe(
    Effect.map(decoded =>
      resolveShortcodeResponseNode(decoded)
        ? ({ _tag: 'Found', raw } as const)
        : ({ _tag: 'Missing', raw } as const)
    )
  );

const attemptShortcodeRequest = (
  request: Effect.Effect<Record<string, unknown>, GraphQLRequestFailed | RateLimited | NetworkError>
): Effect.Effect<ShortcodeFetchAttempt, RateLimited> =>
  request.pipe(
    Effect.flatMap(classifyShortcodeRaw),
    Effect.catchAll(err =>
      err._tag === 'RateLimited'
        ? Effect.fail(err)
        : Effect.succeed({ _tag: 'Failed', error: err } as const)
    )
  );

const fetchShortcodeMediaRaw = (
  shortcode: string
): Effect.Effect<
  Record<string, unknown>,
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  Effect.gen(function* () {
    const state: ShortcodeAttemptState = {};
    for (const { candidate, request } of configuredRequests(
      protocolConfig.operations.mediaByShortcode
    )) {
      const result = yield* attemptShortcodeRequest(
        configuredGraphqlRequest(candidate, request, { shortcode })
      );
      if (result._tag === 'Found') return result.raw;
      rememberShortcodeAttempt(state, result);
    }

    if (state.lastError) return yield* Effect.fail(state.lastError);
    if (state.lastRawWithoutNode) return state.lastRawWithoutNode;
    return yield* Effect.fail(
      state.lastError ?? new ResponseShapeUnknown({ context: 'shortcode_media' })
    );
  });

const fetchShortcodeMediaItems = (
  shortcode: string
): Effect.Effect<
  MediaItem[],
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  fetchShortcodeMediaRaw(shortcode).pipe(
    Effect.flatMap(decodeShortcodeResponse),
    Effect.map(resolveShortcodeResponseNode),
    Effect.flatMap(normalizeKnownShortcodeMedia)
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

const fetchConfiguredReelsMedia = (
  variables: Record<string, unknown>
): Effect.Effect<
  readonly ReelItem[],
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  Effect.gen(function* () {
    let lastError: GraphQLRequestFailed | NetworkError | ResponseShapeUnknown | undefined;
    for (const { candidate, request } of configuredRequests(protocolConfig.operations.reelsMedia)) {
      const result = yield* fetchReelsMedia(
        request.endpoint,
        candidate.kind,
        candidate.id,
        variables,
        configuredGraphqlHeaders(request),
        request.transport === 'form' ? 'POST' : 'GET'
      ).pipe(Effect.either);
      if (result._tag === 'Right') return result.right;
      if (result.left._tag === 'RateLimited') return yield* Effect.fail(result.left);
      lastError = result.left;
    }
    return yield* Effect.fail(lastError ?? new ResponseShapeUnknown({ context: 'reels_media' }));
  });

const fetchHighlightMediaItems = (
  highlightId: string
): Effect.Effect<
  MediaItem[],
  GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown
> =>
  fetchConfiguredReelsMedia(createReelsRequestVariables('highlight', highlightId)).pipe(
    Effect.map(normalizeReelsMediaItems)
  );

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

    const reels = yield* fetchConfiguredReelsMedia(createReelsRequestVariables('story', userId));

    return normalizeReelsMediaItems(reels);
  });

const fetchProfileMediaItems = (
  username: string
): Effect.Effect<MediaItem[], HttpError | NetworkError | ResponseShapeUnknown> => {
  const profileInfoUrl = `${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`;

  return fetchWebProfileInfoUser(profileInfoUrl, 'omit', IG_GRAPHQL_HEADERS).pipe(
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
  | HttpError
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
        return withItemIndexes(yield* fetchShortcodeMediaItems(parsed.shortcode!));
      case 'highlight':
        return withItemIndexes(yield* fetchHighlightMediaItems(parsed.highlightId!));
      case 'story':
        return withItemIndexes(yield* fetchStoryMediaItems(parsed.username!));
      case 'profile':
        return withItemIndexes(yield* fetchProfileMediaItems(parsed.username!));
    }
  });

// ---------------------------------------------------------------------------
// Handler functions — each returns a structured response value
// ---------------------------------------------------------------------------

interface FetchMediaMsg {
  type: 'FETCH_MEDIA';
  url: string;
}

function hasValidMediaDimensions(
  item: MediaItem
): item is MediaItem & { width: number; height: number } {
  return (
    Number.isFinite(item.width) &&
    Number.isFinite(item.height) &&
    item.width! > 0 &&
    item.height! > 0
  );
}

async function handleFetchMedia(msg: FetchMediaMsg): Promise<{
  sourceUrl?: string;
  media:
    | {
        url: string;
        itemIndex: number;
        mediaId?: string;
        history: HistoryMarker;
        type: string;
        filenameHint: string;
        previewUrl?: string;
        width?: number;
        height?: number;
      }[]
    | undefined;
  error: string | undefined;
  failure?: OperationFailure;
}> {
  const source = historySource(msg.url);
  if (!source)
    return {
      media: undefined,
      error: undefined,
      failure: OperationFailure.make({
        code: 'INPUT_INVALID_INSTAGRAM_URL',
        phase: 'input',
        scope: 'batch',
      }),
    };
  const result = await runOperationHandler(
    resolveMediaEffect(source.url).pipe(Effect.map(items => ({ items }))),
    { items: undefined as MediaItem[] | undefined },
    normalizeSourceFailure
  );
  if (result.failure || !result.items)
    return { media: undefined, error: undefined, failure: result.failure };
  const stored = await getHistory();
  if (stored.kind === 'unknown-version')
    return { media: undefined, error: 'Download history uses a newer version.' };
  return {
    sourceUrl: source.url,
    media: result.items.map(item => ({
      url: item.url,
      itemIndex: item.itemIndex,
      ...(item.mediaId ? { mediaId: item.mediaId } : {}),
      type: item.type,
      filenameHint: item.filenameHint,
      previewUrl: item.previewUrl,
      history: historyMarker(stored.entries, source.url, item),
      ...(hasValidMediaDimensions(item) ? { width: item.width, height: item.height } : {}),
    })),
    error: undefined,
  };
}

function historyMarker(
  entries: readonly DownloadHistoryEntry[],
  sourceUrl: string,
  item: MediaItem
): HistoryMarker {
  const matches = entries.filter(
    entry => entry.sourceUrl === sourceUrl && reconcileHistoryEntry(entry, [item]).kind === 'found'
  );
  const latest = matches.reduce<number | undefined>(
    (value, entry) =>
      value === undefined || entry.downloadedAt > value ? entry.downloadedAt : value,
    undefined
  );
  return {
    downloaded: matches.length > 0,
    count: matches.length,
    ...(latest ? { latestDownloadedAt: latest } : {}),
  };
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

interface FetchVideoBlobMsg {
  type: 'FETCH_VIDEO_BLOB';
  url: string;
}

type DownloadAttempt = { operation: DownloadOperation; result: DownloadOperationResult };

function historyFilenameHint(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

async function downloadItem(
  operation: DownloadOperation,
  source: ReturnType<typeof historySource>
): Promise<DownloadAttempt> {
  try {
    await browser.downloads.download({
      url: operation.url,
      filename: operation.filename,
      saveAs: false,
    });
    if (source) {
      try {
        await appendAcceptedHistory(operation, source);
      } catch {
        return {
          operation,
          result: DownloadAcceptedResult.make({
            operationId: operation.operationId,
            requestId: operation.requestId,
            status: 'started',
            warning: OperationWarning.make({ code: 'HISTORY_SAVE_FAILED' }),
          }),
        };
      }
    }
    return {
      operation,
      result: DownloadAcceptedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'started',
      }),
    };
  } catch (cause) {
    return {
      operation,
      result: DownloadFailedResult.make({
        operationId: operation.operationId,
        requestId: operation.requestId,
        status: 'failed',
        failure: normalizeBrowserDownloadFailure(cause),
      }),
    };
  }
}

interface AcceptedHistoryOperation {
  itemIndex: number;
  mediaId?: string;
  mediaType: 'image' | 'video';
  filename: string;
  exportMode?: 'direct' | 'frame' | 'silent';
  frameTimestampSeconds?: number;
}

async function appendAcceptedHistory(
  item: AcceptedHistoryOperation,
  source: NonNullable<ReturnType<typeof historySource>>
) {
  await appendHistory({
    id: createHistoryId(),
    sourceUrl: source.url,
    sourceKind: source.kind,
    itemIndex: item.itemIndex,
    ...(item.mediaId ? { mediaId: item.mediaId } : {}),
    mediaType: item.mediaType,
    filenameHint: historyFilenameHint(item.filename),
    ...(item.exportMode ? { exportMode: item.exportMode } : {}),
    ...(item.frameTimestampSeconds !== undefined
      ? { frameTimestampSeconds: item.frameTimestampSeconds }
      : {}),
    downloadedAt: Date.now(),
    outcome: 'accepted',
  });
}

async function handleDownloadMedia(message: unknown): Promise<DownloadMediaResponse> {
  let request: DownloadMediaRequest;
  try {
    request = await decodeDownloadMediaRequest(message);
  } catch {
    return DownloadMediaResponse.make({
      results: [],
      failure: OperationFailure.make({
        code: 'DOWNLOAD_UNEXPECTED_FAILURE',
        phase: 'browser-download',
        scope: 'batch',
      }),
    });
  }
  const source = request.sourceUrl ? historySource(request.sourceUrl) : null;
  if (request.sourceUrl && !source)
    return DownloadMediaResponse.make({
      results: [],
      failure: OperationFailure.make({
        code: 'INPUT_INVALID_INSTAGRAM_URL',
        phase: 'input',
        scope: 'batch',
      }),
    });
  const attempts = await mapWithConcurrency(request.operations, DOWNLOAD_CONCURRENCY, operation =>
    downloadItem(operation, source)
  );
  return DownloadMediaResponse.make({ results: attempts.map(attempt => attempt.result) });
}

function createHistoryId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

async function handleGetDownloadHistory() {
  const history = await getHistory();
  return history.kind === 'unknown-version'
    ? { entries: [], error: 'Download history uses a newer version.' }
    : { entries: [...history.entries].reverse(), error: undefined };
}

// fallow-ignore-next-line complexity
async function handleRedownloadHistoryEntry(msg: { entryId: string }) {
  const history = await getHistory();
  if (history.kind === 'unknown-version')
    return { error: 'Download history uses a newer version.' };
  const entry = history.entries.find(candidate => candidate.id === msg.entryId);
  if (!entry) return { error: 'This history entry no longer exists.' };
  const resolved = await runHandler(
    resolveMediaEffect(entry.sourceUrl).pipe(Effect.map(items => ({ items }))),
    {
      items: undefined as MediaItem[] | undefined,
    }
  );
  if (resolved.error || !resolved.items)
    return {
      error: `${resolved.error ?? 'Unable to refetch this source.'} History was not changed.`,
    };
  const match = reconcileHistoryEntry(entry, resolved.items);
  if (match.kind === 'missing')
    return { error: 'This item is no longer available at its original source. History was kept.' };
  if (match.kind === 'ambiguous')
    return {
      error: 'GramGrab could not safely match this item after refetching. History was kept.',
    };
  const item = resolved.items.find(candidate => candidate.itemIndex === match.item.itemIndex)!;
  if (entry.exportMode === 'frame') {
    return {
      frame: {
        itemIndex: item.itemIndex,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        filenameHint: item.filenameHint,
        timestampSeconds: entry.frameTimestampSeconds ?? 5,
        sourceUrl: entry.sourceUrl,
      },
      error: undefined,
    };
  }
  if (entry.exportMode === 'silent') {
    return {
      silent: {
        itemIndex: item.itemIndex,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        filenameHint: item.filenameHint,
        sourceUrl: entry.sourceUrl,
      },
      error: undefined,
    };
  }
  return handleDownloadMedia({
    type: 'DOWNLOAD_MEDIA',
    sourceUrl: entry.sourceUrl,
    operations: [
      {
        operationId: createOperationId(),
        requestId: createRequestId(),
        itemIndex: item.itemIndex,
        ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        url: item.url,
        filename: `${item.filenameHint}_${item.itemIndex + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
        originalUrl: item.url,
        originalFilename: `${item.filenameHint}_${item.itemIndex + 1}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
        mediaType: item.type,
      },
    ],
  });
}

async function handleRecordFrameExport(msg: {
  sourceUrl: string;
  item: {
    itemIndex: number;
    mediaId?: string;
    url: string;
    filename: string;
    mediaType: 'video';
    frameTimestampSeconds: number;
  };
}): Promise<{ error: string | undefined }> {
  const source = historySource(msg.sourceUrl);
  if (!source) return { error: 'Invalid Instagram URL.' };
  try {
    await appendAcceptedHistory({ ...msg.item, exportMode: 'frame' }, source);
    return { error: undefined };
  } catch {
    return { error: 'Frame downloaded, but history could not be saved.' };
  }
}

async function handleDownloadFrameExport(
  msg: Parameters<typeof handleRecordFrameExport>[0] & { dataUrl: string }
): Promise<{ error: string | undefined }> {
  try {
    const downloadId = await browser.downloads.download({
      url: msg.dataUrl,
      filename: msg.item.filename,
      saveAs: false,
    });
    if (!(await waitForNonEmptyDownload(downloadId))) return { error: 'Frame download failed.' };
  } catch {
    return { error: 'Frame download failed.' };
  }
  return handleRecordFrameExport(msg);
}

function waitForNonEmptyDownload(downloadId: number): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => settle(false), 10_000);
    const settle = (value: boolean) => {
      clearTimeout(timeout);
      browser.downloads.onChanged.removeListener(listener);
      resolve(value);
    };
    const verify = () =>
      void browser.downloads.search({ id: downloadId }).then(
        items => settle((items[0]?.fileSize ?? 0) > 0),
        () => settle(false)
      );
    const listener = (delta: { id: number; state?: { current?: string } }) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') verify();
      else if (delta.state?.current === 'interrupted') settle(false);
    };
    browser.downloads.onChanged.addListener(listener);
    void browser.downloads.search({ id: downloadId }).then(items => {
      const item = items[0];
      if (item?.state === 'complete') settle((item.fileSize ?? 0) > 0);
      else if (item?.state === 'interrupted') settle(false);
    });
  });
}

async function handleFetchVideoBlob(
  msg: FetchVideoBlobMsg
): Promise<{ dataUrl: string | undefined; error: string | undefined }> {
  return runHandler(fetchBlobAsDataUrl(msg.url).pipe(Effect.map(dataUrl => ({ dataUrl }))), {
    dataUrl: undefined,
  });
}

async function handleRecordSilentExport(msg: {
  sourceUrl: string;
  item: AcceptedHistoryOperation;
}): Promise<{ error: string | undefined }> {
  const source = historySource(msg.sourceUrl);
  if (!source) return { error: 'Invalid Instagram URL.' };
  try {
    await appendAcceptedHistory({ ...msg.item, exportMode: 'silent' }, source);
    return { error: undefined };
  } catch {
    return { error: 'Silent video downloaded, but history could not be saved.' };
  }
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

const CONTEXT_MENU_ROOT = 'gramgrab';
const CONTEXT_MENU_OPEN = 'gramgrab-open';
const CONTEXT_MENU_FETCH = 'gramgrab-fetch';

function contextTargetUrl(info: { pageUrl?: string; linkUrl?: string }): string | undefined {
  return canonicalizeInstagramUrl(info.linkUrl ?? info.pageUrl ?? '')?.url;
}

function workspaceCommand(url: string, intent: 'open' | 'fetch'): WorkspaceSnapshot {
  const createdAt = Date.now();
  return {
    version: 3,
    createdAt,
    expiresAt: createdAt + WORKSPACE_TRANSFER_TTL_MS,
    url,
    fetchedUrl: '',
    status: 'idle',
    message: intent === 'fetch' ? 'Fetching media…' : 'Ready to fetch media.',
    mediaItems: [],
    frameExportSettings: {},
    removeAudioIndexes: [],
    intent,
  };
}

function registerContextMenus(): void {
  void browser.contextMenus
    .removeAll()
    .then(() => {
      browser.contextMenus.create({
        id: CONTEXT_MENU_ROOT,
        title: 'GramGrab',
        contexts: ['page', 'link'],
        // Keep a safe visible fallback for browsers that do not expose onShown.
        // The click handler still validates the target before doing any work.
        visible: true,
      });
      browser.contextMenus.create({
        id: CONTEXT_MENU_OPEN,
        parentId: CONTEXT_MENU_ROOT,
        title: 'Open in GramGrab',
        contexts: ['page', 'link'],
      });
      browser.contextMenus.create({
        id: CONTEXT_MENU_FETCH,
        parentId: CONTEXT_MENU_ROOT,
        title: 'Fetch with GramGrab',
        contexts: ['page', 'link'],
      });
    })
    .catch(err => console.warn('Could not register GramGrab context menus:', err));
}

browser.contextMenus.onShown.addListener(info => {
  void browser.contextMenus
    .update(CONTEXT_MENU_ROOT, { visible: Boolean(contextTargetUrl(info)) })
    .then(() => browser.contextMenus.refresh())
    .catch(err => console.warn('Could not update GramGrab context menu visibility:', err));
});

browser.contextMenus.onClicked.addListener(info => {
  const url = contextTargetUrl(info);
  if (!url) return;
  const intent = info.menuItemId === CONTEXT_MENU_FETCH ? 'fetch' : 'open';
  if (info.menuItemId !== CONTEXT_MENU_OPEN && info.menuItemId !== CONTEXT_MENU_FETCH) return;
  void replaceWorkspace(workspaceCommand(url, intent)).catch(err =>
    console.warn('Could not open GramGrab workspace from context menu:', err)
  );
});

registerContextMenus();

let runnerTabId: number | undefined;
let runnerWindowId: number | undefined;
let runnerReady: Promise<number> | undefined;
let resolveRunnerReady: ((tabId: number) => void) | undefined;
let runnerProgress: ((event: Progress) => void) | undefined;
let runnerIdleTimer: ReturnType<typeof setTimeout> | undefined;
let exportQueue: Promise<void> = Promise.resolve();

function cancellationError(): Error {
  return new Error('Request cancelled.');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancellationError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function discardRunner(): void {
  const tabId = runnerTabId;
  const windowId = runnerWindowId;
  runnerTabId = undefined;
  runnerWindowId = undefined;
  runnerReady = undefined;
  resolveRunnerReady = undefined;
  if (windowId !== undefined) void browser.windows.remove(windowId).catch(() => undefined);
  else if (tabId !== undefined) void browser.tabs.remove(tabId).catch(() => undefined);
}

async function getRunner(): Promise<number> {
  if (!runnerReady) {
    runnerReady = new Promise(resolve => {
      resolveRunnerReady = resolve;
    });
    const runnerWindow = await browser.windows.create({
      url: browser.runtime.getURL('runner.html'),
      focused: false,
      state: 'minimized',
      type: 'popup',
    });
    runnerWindowId = runnerWindow.id;
    runnerTabId = runnerWindow.tabs?.[0]?.id;
  }
  return Promise.race([
    runnerReady,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The extension runner did not become ready.')), 5_000)
    ),
  ]);
}

async function runInDocument(command: ProtocolExport): Promise<unknown> {
  const tabId = await getRunner();
  return browser.tabs.sendMessage(tabId, {
    type: 'RUN_EXPORT',
    sourceUrl: command.sourceUrl,
    command,
  });
}

function protocolFailure(failure: OperationFailure): ProtocolOperationFailure {
  return ProtocolOperationFailure.make({ code: failure.code, scope: failure.scope });
}

async function inspectCommand(sourceUrl: string): Promise<InspectResult> {
  const response = await handleFetchMedia({ type: 'FETCH_MEDIA', url: sourceUrl });
  if (response.failure) throw protocolFailure(response.failure);
  if (!response.media || !response.sourceUrl)
    throw ProtocolOperationFailure.make({ code: 'SOURCE_MEDIA_NOT_FOUND', scope: 'batch' });
  return InspectResult.make({
    sourceUrl: response.sourceUrl,
    items: response.media.map((item, index) =>
      InspectedMedia.make({
        itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(index + 1),
        mediaIdentity: MediaIdentity.make({
          itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(item.itemIndex),
          ...(item.mediaId ? { mediaId: item.mediaId } : {}),
        }),
        mediaType: item.type === 'video' ? 'video' : 'image',
        url: item.url,
        ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
        filenameHint: item.filenameHint,
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        history: ProtocolHistoryMarker.make(item.history),
      })
    ),
  });
}

function historyEntry(entry: DownloadHistoryEntry): ProtocolHistoryEntry {
  return ProtocolHistoryEntry.make({
    id: entry.id,
    sourceUrl: entry.sourceUrl,
    sourceKind: entry.sourceKind,
    mediaIdentity: MediaIdentity.make({
      itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(entry.itemIndex),
      ...(entry.mediaId ? { mediaId: entry.mediaId } : {}),
    }),
    mediaType: entry.mediaType,
    filenameHint: entry.filenameHint,
    ...(entry.exportMode ? { exportMode: entry.exportMode } : {}),
    ...(entry.frameTimestampSeconds === undefined
      ? {}
      : { frameTimestampSeconds: entry.frameTimestampSeconds }),
    downloadedAt: entry.downloadedAt,
  });
}

async function runExport(
  command: ProtocolExport,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
) {
  if (command.operations.every(operation => operation.mode._tag === 'DirectExport'))
    return runDirectExport(command, emit, signal);
  let release = () => {};
  const turn = new Promise<void>(resolve => {
    release = resolve;
  });
  const previous = exportQueue;
  exportQueue = previous.then(() => turn);
  const abort = () => discardRunner();
  try {
    await abortable(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  try {
    if (runnerIdleTimer) clearTimeout(runnerIdleTimer);
    runnerIdleTimer = undefined;
    runnerProgress = emit;
    signal.addEventListener('abort', abort, { once: true });
    try {
      return Schema.decodeUnknownSync(CommandResult)(
        await abortable(runInDocument(command), signal)
      );
    } catch {
      if (signal.aborted) throw cancellationError();
      const staleTabId = runnerTabId;
      runnerTabId = undefined;
      runnerReady = undefined;
      if (staleTabId !== undefined) discardRunner();
      return Schema.decodeUnknownSync(CommandResult)(
        await abortable(runInDocument(command), signal)
      );
    }
  } finally {
    signal.removeEventListener('abort', abort);
    runnerProgress = undefined;
    release();
    discardRunner();
  }
}

// fallow-ignore-next-line complexity
async function runDirectExport(
  command: ProtocolExport,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
) {
  const inspected = await abortable(inspectCommand(command.sourceUrl), signal);
  const operations: DownloadOperation[] = [];
  for (const requested of command.operations) {
    const item = inspected.items[requested.itemNumber - 1];
    if (
      !item ||
      (requested.mediaIdentity &&
        (requested.mediaIdentity.itemIndex !== item.mediaIdentity.itemIndex ||
          (requested.mediaIdentity.mediaId !== undefined &&
            requested.mediaIdentity.mediaId !== item.mediaIdentity.mediaId)))
    )
      continue;
    emit(
      Progress.make({
        operationId: requested.operationId,
        itemNumber: requested.itemNumber,
        phase: 'direct-download',
      })
    );
    const extension = item.mediaType === 'video' ? 'mp4' : 'jpg';
    operations.push({
      operationId: requested.operationId,
      requestId: createRequestId(),
      itemIndex: item.mediaIdentity.itemIndex,
      ...(item.mediaIdentity.mediaId ? { mediaId: item.mediaIdentity.mediaId } : {}),
      url: item.url,
      filename: `${item.filenameHint}_${item.mediaIdentity.itemIndex + 1}.${extension}`,
      originalUrl: item.url,
      originalFilename: `${item.filenameHint}_${item.mediaIdentity.itemIndex + 1}.${extension}`,
      mediaType: item.mediaType,
    });
  }
  if (signal.aborted) throw cancellationError();
  const response = await handleDownloadMedia({
    sourceUrl: command.sourceUrl,
    operations,
  });
  const batchFailure = response.failure;
  const results = batchFailure
    ? operations.map(operation =>
        DownloadFailedResult.make({
          operationId: operation.operationId,
          requestId: operation.requestId,
          status: 'failed',
          failure: batchFailure,
        })
      )
    : response.results;
  return ProtocolExportResult.make({
    outcomes: command.operations.map(requested => {
      const result = results.find(candidate => candidate.operationId === requested.operationId);
      const identity =
        requested.mediaIdentity ??
        MediaIdentity.make({
          itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(requested.itemNumber - 1),
        });
      return result?.status === 'started'
        ? ItemSucceeded.make({
            operationId: requested.operationId,
            itemNumber: requested.itemNumber,
            mediaIdentity: identity,
          })
        : ItemFailed.make({
            operationId: requested.operationId,
            itemNumber: requested.itemNumber,
            mediaIdentity: identity,
            failure:
              result?.status === 'failed'
                ? protocolFailure(result.failure)
                : ProtocolOperationFailure.make({ code: 'MEDIA_NOT_FOUND', scope: 'item' }),
          });
    }),
  });
}

// fallow-ignore-next-line complexity
async function executeCommand(
  request: Request,
  emit: (event: EventPayload) => void,
  signal: AbortSignal
): Promise<void> {
  try {
    const command = request.command;
    let result: CommandResult;
    switch (command._tag) {
      case 'Inspect':
        emit(Progress.make({ phase: 'resolving' }));
        result = await abortable(inspectCommand(command.sourceUrl), signal);
        break;
      case 'Export':
        emit(Progress.make({ phase: 'resolving' }));
        result = await runExport(command, emit, signal);
        break;
      case 'HistoryList': {
        emit(Progress.make({ phase: 'history' }));
        const history = await abortable(getHistory(), signal);
        if (history.kind === 'unknown-version') throw new Error('Unsupported history version.');
        result = HistoryListResult.make({
          entries: [...history.entries].reverse().map(historyEntry),
          repaired: history.repaired,
        });
        break;
      }
      case 'HistoryRemove': {
        const before = await abortable(getHistory(), signal);
        if (before.kind === 'unknown-version') throw new Error('Unsupported history version.');
        const known = new Set(before.entries.map(entry => entry.id));
        const removedEntryIds = command.entryIds.filter(id => known.has(id));
        for (const id of removedEntryIds) await abortable(removeHistory(id), signal);
        result = HistoryRemoveResult.make({
          removedEntryIds,
          unknownEntryIds: command.entryIds.filter(id => !known.has(id)),
        });
        break;
      }
      case 'HistoryClear': {
        const before = await abortable(getHistory(), signal);
        if (before.kind === 'unknown-version') throw new Error('Unsupported history version.');
        await abortable(clearHistory(), signal);
        result = HistoryClearResult.make({ clearedCount: before.entries.length });
        break;
      }
      case 'HistoryRedownload': {
        const before = await abortable(getHistory(), signal);
        if (before.kind === 'unknown-version') throw new Error('Unsupported history version.');
        const known = new Set(before.entries.map(entry => entry.id));
        const outcomes = [];
        for (const entryId of command.entryIds.filter(id => known.has(id))) {
          signal.throwIfAborted();
          const entry = before.entries.find(candidate => candidate.id === entryId);
          const response = await abortable(handleRedownloadHistoryEntry({ entryId }), signal);
          const frame = 'frame' in response ? response.frame : undefined;
          const silent = 'silent' in response ? response.silent : undefined;
          const resolvedItem = frame ?? silent;
          if (entry && resolvedItem) {
            const operationId = Schema.decodeUnknownSync(ProtocolOperationId)(crypto.randomUUID());
            const exportResult = await runExport(
              ProtocolExport.make({
                sourceUrl: entry.sourceUrl,
                operations: [
                  ProtocolExportOperation.make({
                    operationId,
                    itemNumber: Schema.decodeUnknownSync(HumanItemNumber)(
                      resolvedItem.itemIndex + 1
                    ),
                    mediaIdentity: MediaIdentity.make({
                      itemIndex: Schema.decodeUnknownSync(InternalItemIndex)(
                        resolvedItem.itemIndex
                      ),
                      ...(resolvedItem.mediaId ? { mediaId: resolvedItem.mediaId } : {}),
                    }),
                    mode: frame
                      ? FrameExport.make({
                          timestampSeconds: frame.timestampSeconds,
                        })
                      : SilentExport.make({ reencode: 'allow' }),
                  }),
                ],
              }),
              emit,
              signal
            );
            const failed =
              exportResult._tag === 'ExportResult' &&
              exportResult.outcomes.some(outcome => outcome._tag !== 'ItemSucceeded');
            outcomes.push(
              failed
                ? HistoryRedownloadFailed.make({
                    entryId,
                    failure: ProtocolOperationFailure.make({
                      code: 'DOWNLOAD_UNEXPECTED_FAILURE',
                      scope: 'item',
                    }),
                  })
                : HistoryRedownloadStarted.make({ entryId })
            );
            continue;
          }
          const directFailed =
            'results' in response &&
            (response.failure || response.results.some(result => result.status !== 'started'));
          const error = 'error' in response ? response.error : undefined;
          outcomes.push(
            error || directFailed
              ? HistoryRedownloadFailed.make({
                  entryId,
                  failure: ProtocolOperationFailure.make({
                    code: 'MEDIA_NOT_FOUND',
                    scope: 'item',
                  }),
                })
              : HistoryRedownloadStarted.make({ entryId })
          );
        }
        result = HistoryRedownloadResult.make({
          outcomes,
          unknownEntryIds: command.entryIds.filter(id => !known.has(id)),
        });
        break;
      }
      case 'DebugGet': {
        signal.throwIfAborted();
        emit(Progress.make({ phase: 'diagnostics' }));
        result = DebugGetResult.make({
          diagnosticsVersion: 1,
          report: JSON.stringify(
            {
              diagnosticsVersion: 1,
              capturedAt: new Date().toISOString(),
              extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
              browser: browserName(),
            },
            null,
            2
          ),
        });
        break;
      }
      case 'DebugExport': {
        signal.throwIfAborted();
        const filename = `gramgrab-debug-${Date.now()}.json`;
        const report = {
          diagnosticsVersion: 1,
          capturedAt: new Date().toISOString(),
          extensionVersion: browser.runtime.getManifest().version ?? 'unknown',
          browser: browserName(),
        };
        await browser.downloads.download({
          url: jsonToDataUrl(report),
          filename,
          saveAs: true,
        });
        result = DebugExportResult.make({
          diagnosticsVersion: 1,
          filename,
          status: 'started',
        });
        break;
      }
      default:
        throw new Error('Unsupported command.');
    }
    emit(Completed.make({ result }));
  } catch (error) {
    emit(
      Rejected.make({
        failure:
          error instanceof ProtocolOperationFailure
            ? { _tag: 'CommandFailure', failure: error }
            : ValidationFailure.make({
                message: error instanceof Error ? error.message : String(error),
              }),
      })
    );
  }
}

function browserName(): 'chromium' | 'firefox' | 'unknown' {
  const userAgent = globalThis.navigator?.userAgent ?? '';
  if (/Firefox/i.test(userAgent)) return 'firefox';
  return /Chrom(?:e|ium)/i.test(userAgent) ? 'chromium' : 'unknown';
}

startNativeBridge(executeCommand);
browser.runtime.onStartup.addListener(() => startNativeBridge(executeCommand));

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

type MessageHandler = (message: unknown) => Promise<unknown>;

const messageHandlers: Record<string, MessageHandler> = {
  FETCH_MEDIA: message => handleFetchMedia(message as FetchMediaMsg),
  GET_PREVIEW_URL: message => handleGetPreviewUrl(message as GetPreviewUrlMsg),
  DOWNLOAD_MEDIA: message => handleDownloadMedia(message),
  GET_DOWNLOAD_HISTORY: () => handleGetDownloadHistory(),
  DELETE_HISTORY_ENTRY: async message => {
    try {
      const entries = await removeHistory((message as { entryId: string }).entryId);
      return { entries: [...entries].reverse(), error: undefined };
    } catch (err) {
      return { entries: [], error: String(err) };
    }
  },
  CLEAR_DOWNLOAD_HISTORY: async () => {
    try {
      await clearHistory();
      return { error: undefined };
    } catch (err) {
      return { error: String(err) };
    }
  },
  REDOWNLOAD_HISTORY_ENTRY: message => handleRedownloadHistoryEntry(message as { entryId: string }),
  RECORD_FRAME_EXPORT: message =>
    handleRecordFrameExport(message as Parameters<typeof handleRecordFrameExport>[0]),
  DOWNLOAD_FRAME_EXPORT: message =>
    handleDownloadFrameExport(message as Parameters<typeof handleDownloadFrameExport>[0]),
  RECORD_SILENT_EXPORT: message =>
    handleRecordSilentExport(message as Parameters<typeof handleRecordSilentExport>[0]),
  FETCH_VIDEO_BLOB: message => handleFetchVideoBlob(message as FetchVideoBlobMsg),
  DEBUG_SHAPE: message => handleDebugShape(message as DebugShapeMsg),
  DOWNLOAD_DEBUG_JSON: message => handleDownloadDebugJson(message as DownloadDebugJsonMsg),
};

// fallow-ignore-next-line complexity
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const internal = msg as {
    type?: string;
    operationId?: import('@gramgrab/protocol').OperationId;
    itemNumber?: import('@gramgrab/protocol').HumanItemNumber;
    phase?: string;
    progress?: number;
  };
  if (internal.type === 'RUNNER_READY' && sender.tab?.id !== undefined) {
    runnerTabId = sender.tab.id;
    resolveRunnerReady?.(sender.tab.id);
    resolveRunnerReady = undefined;
    return false;
  }
  if (internal.type === 'RUNNER_PROGRESS' && internal.phase) {
    const phases: Record<string, Progress['phase']> = {
      'direct-download': 'direct-download',
      'frame-metadata': 'frame-metadata',
      'frame-export': 'frame-export',
      queued: 'silent-inspection',
      inspecting: 'silent-inspection',
      copying: 'silent-copy',
      reencoding: 'silent-reencode',
      validating: 'silent-validation',
      downloading: 'silent-validation',
    };
    runnerProgress?.(
      Progress.make({
        ...(internal.operationId ? { operationId: internal.operationId } : {}),
        ...(internal.itemNumber ? { itemNumber: internal.itemNumber } : {}),
        phase: phases[internal.phase] ?? 'silent-inspection',
        ...(internal.progress === undefined ? {} : { progress: internal.progress }),
      })
    );
    return false;
  }
  const handler = messageHandlers[(msg as { type?: string }).type ?? ''];
  if (!handler) return false;
  void handler(msg).then(sendResponse);
  return true;
});
