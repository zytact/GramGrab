import { Effect, Schema } from 'effect';
import { browser } from '../lib/browser.ts';
import { canonicalizeInstagramUrl, type InstagramTarget } from '../workspace/contracts.ts';
import {
  protocolConfig,
  type ProtocolCandidate,
  type ProtocolOperation,
  type ProtocolRequest,
} from '../instagram-protocol/config.ts';
import {
  fetchHdAvatarUser,
  fetchHighlightsTray,
  fetchInstantsFeed,
  fetchReelsMedia,
  fetchTopSearchUserId,
  fetchWebProfileInfoUser,
  graphqlFetch as graphqlFetchEffect,
  graphqlPost as graphqlPostEffect,
} from '../effect/instagram.ts';
import { ShortcodeMediaResponseSchema } from '../effect/schemas.ts';
import {
  GraphQLRequestFailed,
  InvalidInstagramUrl,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
  UsernameUnresolved,
} from '../effect/errors.ts';
import { fetchRestShortcodeMedia } from './rest-shortcode.ts';
import {
  normalizeHighlightCovers,
  normalizeInstantItems,
  normalizeKnownShortcodeMedia,
  normalizeProfilePicture,
  normalizeReelsMediaItems,
  withItemIndexes,
  type MediaItem,
} from './normalize.ts';
import type { WatchRequestDeferred } from './requests.ts';

export const IG_HEADERS = {
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

type ParsedUrl = InstagramTarget;

type ShortcodeMediaResponse = Schema.Schema.Type<typeof ShortcodeMediaResponseSchema>;

export function parseInstagramUrl(url: string): ParsedUrl | null {
  return canonicalizeInstagramUrl(url)?.target ?? null;
}

export function resolveUsernameToId(username: string) {
  const url = `${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`;
  const headers = { ...IG_HEADERS, Origin: 'https://www.instagram.com' };
  return fetchWebProfileInfoUser(url, 'include', headers).pipe(
    Effect.map(user => {
      const userId = user?.id ?? user?.pk;
      return userId != null ? String(userId) : null;
    }),
    // Instagram throttles web_profile_info hard enough to 429 an ordinary signed-in session, so
    // topsearch resolves the id instead. Its own failure surfaces the original one, which carries
    // the recovery the person actually needs.
    Effect.catchAll(profileError =>
      fetchTopSearchUserId(username, headers).pipe(
        Effect.map(userId => userId ?? null),
        Effect.catchAll(() => Effect.fail(profileError))
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Shared Effect pipelines — parse → fetch → normalize
// ---------------------------------------------------------------------------

export const IG_GRAPHQL_HEADERS = { ...IG_HEADERS, Origin: 'https://www.instagram.com' } as const;
export const IG_API_GRAPHQL_HEADERS = {
  ...IG_GRAPHQL_HEADERS,
  Referer: 'https://www.instagram.com/',
  'X-ASBD-ID': protocolConfig.client.asbdId,
} as const;

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

const fetchShortcodeMediaItems = (shortcode: string) =>
  Effect.gen(function* () {
    const rest = yield* fetchRestShortcodeMedia(shortcode).pipe(Effect.either);
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
    return yield* normalizeKnownShortcodeMedia(resolveShortcodeResponseNode(decoded));
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

const fetchHighlightMediaItems = (highlightId: string) =>
  fetchConfiguredReelsMedia(createReelsRequestVariables('highlight', highlightId)).pipe(
    Effect.map(normalizeReelsMediaItems)
  );

const fetchStoryMediaItems = (username: string) =>
  Effect.gen(function* () {
    const userId = yield* resolveUsernameToId(username);

    if (!userId) {
      return yield* Effect.fail(new UsernameUnresolved({ username }));
    }

    const reels = yield* fetchConfiguredReelsMedia(createReelsRequestVariables('story', userId));

    return normalizeReelsMediaItems(reels);
  });

const fetchProfileMediaItems = (username: string) => {
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

/** Reads `csrftoken` for an Instagram request that sends it straight back; never stored. */
export const readCsrfToken = Effect.tryPromise({
  try: () => browser.cookies.get({ url: 'https://www.instagram.com/', name: 'csrftoken' }),
  catch: cause => new NetworkError({ cause }),
}).pipe(Effect.map(cookie => cookie?.value ?? ''));

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

export const fetchInstantMediaItems = () =>
  fetchInstantItems().pipe(Effect.flatMap(normalizeInstantItems));

export const resolveMediaEffect = (url: string) =>
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
