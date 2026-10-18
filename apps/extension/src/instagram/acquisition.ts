import { Effect, Schema } from 'effect';
import { canonicalizeInstagramUrl, type InstagramTarget } from '../workspace/contracts.ts';
import {
  protocolConfig,
  type ProtocolCandidate,
  type ProtocolOperation,
  type ProtocolRequest,
} from '../instagram-protocol/config.ts';
import {
  fetchHighlightsTray,
  fetchInstantsFeed,
  fetchReelsMedia,
  graphqlFetch as graphqlFetchEffect,
  graphqlPost as graphqlPostEffect,
} from '../effect/instagram.ts';
import { ShortcodeMediaResponseSchema, type InstantItem } from '../effect/schemas.ts';
import {
  GraphQLRequestFailed,
  InvalidInstagramUrl,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
  UsernameUnresolved,
} from '../effect/errors.ts';
import { fetchPostsPage } from '../watch/posts.ts';
import { confirmProfile, requireOk, WireAccountId } from '../watch/identity.ts';
import { fetchedMedia, type FetchedMedia } from '../watch/contracts.ts';
import { decodeRestShortcodeMedia, fetchRestShortcodeRaw, fetchedPost } from './rest-shortcode.ts';
import {
  normalizeHighlightCovers,
  normalizeInstantItems,
  normalizeKnownShortcodeMedia,
  normalizeProfilePicture,
  normalizeReelsMediaItems,
  withItemIndexes,
  type MediaItem,
} from './normalize.ts';
import { IG_API_GRAPHQL_HEADERS, IG_GRAPHQL_HEADERS, readCsrfToken } from './headers.ts';
import { InstagramRequests, type WatchRequestDeferred } from './requests.ts';

type ParsedUrl = InstagramTarget;

type ShortcodeMediaResponse = Schema.Schema.Type<typeof ShortcodeMediaResponseSchema>;

/** The media a person asked for, and how a Watch check would identify it. */
export interface Resolution {
  readonly items: MediaItem[];
  readonly fetched: readonly FetchedMedia[];
}

export function parseInstagramUrl(url: string): ParsedUrl | null {
  return canonicalizeInstagramUrl(url)?.target ?? null;
}

/** Owners of a Posts page. Instagram answers `data: null` with `errors` for an unknown username. */
const PostOwners = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      xdt_api__v1__feed__user_timeline_graphql_connection: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({
            node: Schema.Struct({
              user: Schema.Struct({ pk: WireAccountId, username: Schema.String }),
            }),
          })
        ),
      }),
    })
  ),
});

/** The account ID on `username`'s own Posts. A collab Post can belong to another account. */
const idFromPosts = (username: string) =>
  fetchPostsPage(username, undefined).pipe(
    Effect.flatMap(raw =>
      Schema.decodeUnknown(PostOwners)(raw).pipe(
        Effect.mapError(() => new ResponseShapeUnknown({ context: 'profile_posts' }))
      )
    ),
    Effect.map(
      ({ data }) =>
        data?.xdt_api__v1__feed__user_timeline_graphql_connection.edges.find(
          ({ node }) => node.user.username.toLowerCase() === username.toLowerCase()
        )?.node.user.pk
    )
  );

const PROFILE_PAGE_ID = /"profile_id":"(\d+)"/;

/** The account ID the profile page names, for an account with no Posts to read it from. */
const idFromProfilePage = (username: string) =>
  Effect.gen(function* () {
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch(
      `https://www.instagram.com/${encodeURIComponent(username)}/`,
      { credentials: 'include' }
    );
    if (response.status === 404) return undefined;
    yield* requireOk(response);
    const page = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: cause => new NetworkError({ cause }),
    });
    return PROFILE_PAGE_ID.exec(page)?.[1];
  });

/** Looks an account ID up by username with the person's session, or undefined for no account. */
export const resolveUsernameToId = (username: string) =>
  idFromPosts(username).pipe(
    Effect.flatMap(id => (id ? Effect.succeed(id) : idFromProfilePage(username)))
  );

// ---------------------------------------------------------------------------
// Shared Effect pipelines — parse → fetch → normalize
// ---------------------------------------------------------------------------

export function configuredGraphqlHeaders(request: ProtocolRequest): Record<string, string> {
  return {
    ...(request.transport === 'form' ? IG_API_GRAPHQL_HEADERS : IG_GRAPHQL_HEADERS),
  };
}

export function configuredRequests(operation: ProtocolOperation) {
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
  const operationKey = candidate.kind === 'client_doc_id' ? 'doc_id' : candidate.kind;
  return request.transport === 'form'
    ? graphqlPostEffect(request.endpoint, candidate.id, variables, headers, operationKey)
    : graphqlFetchEffect(request.endpoint, operationKey, candidate.id, variables, headers);
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

const attemptShortcodeRequest = <R>(
  request: Effect.Effect<
    Record<string, unknown>,
    GraphQLRequestFailed | RateLimited | NetworkError | ResponseShapeUnknown | WatchRequestDeferred,
    R
  >
) =>
  request.pipe(
    Effect.flatMap(classifyShortcodeRaw),
    Effect.catchAll(err =>
      err._tag === 'RateLimited' || err._tag === 'WatchRequestDeferred'
        ? Effect.fail(err)
        : Effect.succeed({ _tag: 'Failed', error: err } as const)
    )
  );

const fetchShortcodeMediaRaw = (shortcode: string) =>
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

const fetchRestResolution = (shortcode: string) =>
  fetchRestShortcodeRaw(shortcode).pipe(
    Effect.flatMap(raw =>
      decodeRestShortcodeMedia(raw, shortcode).pipe(
        Effect.map((items): Resolution => ({ items, fetched: fetchedPost(raw, shortcode) }))
      )
    )
  );

const fetchShortcodeMedia = (shortcode: string) =>
  Effect.gen(function* () {
    const rest = yield* fetchRestResolution(shortcode).pipe(Effect.either);
    if (rest._tag === 'Right') return rest.right;
    const error = rest.left;
    if (
      error._tag === 'RateLimited' ||
      error._tag === 'ResponseShapeUnknown' ||
      (error._tag === 'HttpError' && [401, 403].includes(error.status))
    )
      return yield* Effect.fail(error);
    const raw = yield* fetchShortcodeMediaRaw(shortcode);
    const decoded = yield* decodeShortcodeResponse(raw);
    const items = yield* normalizeKnownShortcodeMedia(resolveShortcodeResponseNode(decoded));
    return { items, fetched: [] } satisfies Resolution;
  });

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

const fetchConfiguredReelsMedia = (variables: Record<string, unknown>) =>
  Effect.gen(function* () {
    let lastError: GraphQLRequestFailed | NetworkError | ResponseShapeUnknown | undefined;
    for (const { candidate, request } of configuredRequests(protocolConfig.operations.reelsMedia)) {
      const result = yield* fetchReelsMedia(
        request.endpoint,
        candidate.kind === 'client_doc_id' ? 'doc_id' : candidate.kind,
        candidate.id,
        variables,
        configuredGraphqlHeaders(request),
        request.transport === 'form' ? 'POST' : 'GET'
      ).pipe(Effect.either);
      if (result._tag === 'Right') return result.right;
      if (result.left._tag === 'RateLimited' || result.left._tag === 'WatchRequestDeferred')
        return yield* Effect.fail(result.left);
      lastError = result.left;
    }
    return yield* Effect.fail(lastError ?? new ResponseShapeUnknown({ context: 'reels_media' }));
  });

const fetchHighlightMedia = (highlightId: string) =>
  fetchConfiguredReelsMedia(createReelsRequestVariables('highlight', highlightId)).pipe(
    Effect.map(
      (reels): Resolution => ({ items: normalizeReelsMediaItems(reels, 'highlight'), fetched: [] })
    )
  );

const fetchStoryMedia = (username: string) =>
  Effect.gen(function* () {
    const userId = yield* resolveUsernameToId(username);

    if (!userId) {
      return yield* Effect.fail(new UsernameUnresolved({ username }));
    }

    const reels = yield* fetchConfiguredReelsMedia(createReelsRequestVariables('story', userId));

    const fetched = fetchedMedia(
      reels.flatMap(reel =>
        reel.items.map(item => ({
          kind: 'stories',
          owners: [String(reel.id)],
          mediaId: item.id,
          takenAt: 'taken_at_timestamp' in item ? item.taken_at_timestamp : undefined,
        }))
      )
    );
    return { items: normalizeReelsMediaItems(reels, 'story'), fetched } satisfies Resolution;
  });

const fetchProfileMedia = (username: string) =>
  Effect.gen(function* () {
    const userId = yield* resolveUsernameToId(username);
    if (!userId) return yield* Effect.fail(new UsernameUnresolved({ username }));

    const avatarEffect = confirmProfile(userId).pipe(
      Effect.mapError(error =>
        error._tag === 'UsernameUnconfirmed' ? new UsernameUnresolved({ username }) : error
      ),
      Effect.map(profile => normalizeProfilePicture(profile, username))
    );
    const coversEffect = fetchHighlightsTray(userId, IG_GRAPHQL_HEADERS).pipe(
      Effect.map(tray => normalizeHighlightCovers(tray, username)),
      Effect.catchAll(err =>
        Effect.sync(() => {
          console.warn('highlights_tray failed:', err);
          return [] as MediaItem[];
        })
      )
    );

    const [avatar, covers] = yield* Effect.all([avatarEffect, coversEffect], {
      concurrency: 'unbounded',
    });
    return { items: [...avatar, ...covers], fetched: [] } satisfies Resolution;
  });

/** The signed-in viewer's active Instants feed, decoded but not yet normalized. */
export const fetchInstantItems = () => {
  const operation = protocolConfig.operations.instantsFeed;
  if (!operation) return Effect.fail(new ResponseShapeUnknown({ context: 'instants_protocol' }));
  const candidate = operation.candidates[0]!;
  const request = candidate.requests[0]!;
  if (candidate.kind !== 'client_doc_id' || !operation.friendlyName)
    return Effect.fail(new ResponseShapeUnknown({ context: 'instants_protocol' }));
  return readCsrfToken.pipe(
    Effect.flatMap(csrfToken =>
      fetchInstantsFeed(request.endpoint, candidate.id, operation.friendlyName!, csrfToken, {
        ...IG_API_GRAPHQL_HEADERS,
        'X-IG-App-ID': operation.appId ?? protocolConfig.client.appId,
      })
    )
  );
};

/**
 * The Instants the feed holds, as an Instants check of each owner would find them: an Instant's
 * ID ends with its owner's account ID.
 */
const fetchedInstants = (items: readonly InstantItem[]) =>
  fetchedMedia(
    items.flatMap(item =>
      'media_type' in item && item.id.endsWith(`_${item.user.id}`)
        ? [{ kind: 'instants', owners: [item.user.id], mediaId: item.id, takenAt: item.taken_at }]
        : []
    )
  );

export const fetchInstantMedia = () =>
  fetchInstantItems().pipe(
    Effect.flatMap(raw =>
      normalizeInstantItems(raw).pipe(
        Effect.map((items): Resolution => ({ items, fetched: fetchedInstants(raw) }))
      )
    )
  );

const indexed = (resolution: Resolution): Resolution => ({
  ...resolution,
  items: withItemIndexes(resolution.items),
});

export const resolveMediaEffect = (url: string) =>
  Effect.gen(function* () {
    const parsed = parseInstagramUrl(url);
    if (!parsed) return yield* Effect.fail(new InvalidInstagramUrl({ url }));

    switch (parsed.type) {
      case 'post':
      case 'reel':
        return indexed(yield* fetchShortcodeMedia(parsed.shortcode!));
      case 'highlight':
        return indexed(yield* fetchHighlightMedia(parsed.highlightId!));
      case 'story':
        return indexed(yield* fetchStoryMedia(parsed.username!));
      case 'profile':
        return indexed(yield* fetchProfileMedia(parsed.username!));
    }
  });
