import { Effect, Either, Schema } from 'effect';
import { InstagramUsername, type CheckIncompleteReason } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { IG_API_GRAPHQL_HEADERS, readCsrfToken } from '../instagram/acquisition.ts';
import { InstagramRequests } from '../instagram/requests.ts';
import { AnswerUntrusted, ResponseShapeUnknown } from '../effect/errors.ts';
import { MediaId, Shortcode, type TimedRef } from './contracts.ts';
import { readJson } from './identity.ts';

const PAGE_SIZE = 12;
/** A Watch turn reads at most this many Posts pages; a longer traversal continues later. */
export const PAGES_PER_TURN = 3;
const Seconds = Schema.Number.pipe(Schema.int(), Schema.positive());
const CLOCK_SKEW_SECONDS = 5 * 60;

const Child = Schema.Struct({ pk: Schema.String, media_type: Schema.Literal(1, 2) });

/** Identities are plain strings on the wire; `readPostsPage` checks them exactly. */
const PostNode = Schema.Struct({
  pk: Schema.String,
  code: Schema.String,
  media_type: Schema.Literal(1, 2, 8),
  taken_at: Seconds,
  user: Schema.Struct({ pk: Schema.String }),
  coauthor_producers: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ pk: Schema.String })))
  ),
  carousel_media_count: Schema.optional(Schema.NullOr(Schema.Number)),
  carousel_media: Schema.optional(Schema.NullOr(Schema.Array(Child))),
});
type PostNode = Schema.Schema.Type<typeof PostNode>;

/** One page of an account's Posts grid, as both the first-page and cursor-page queries answer. */
export const PostsResponse = Schema.Struct({
  data: Schema.Struct({
    xdt_api__v1__feed__user_timeline_graphql_connection: Schema.Struct({
      edges: Schema.Array(Schema.Struct({ node: PostNode })),
      page_info: Schema.Struct({
        end_cursor: Schema.NullOr(Schema.String),
        has_next_page: Schema.Boolean,
      }),
    }),
  }),
});

/** A GraphQL answer that reports errors, which Instagram sends with or without `data`. */
const isErrored = Schema.is(Schema.Struct({ errors: Schema.NonEmptyArray(Schema.Unknown) }));

export interface PostsPage {
  readonly refs: readonly TimedRef[];
  /** The cursor of the next page, or undefined when Instagram says the list ended. */
  readonly next: string | undefined;
}

const MEDIA_TYPE = { 1: 'image', 2: 'video' } as const;

const isMediaId = Schema.is(MediaId);
const isShortcode = Schema.is(Shortcode);

/** A collab Post lists the target as a co-author while another account owns it. */
const belongsTo = (node: PostNode, targetId: string) =>
  node.user.pk === targetId ||
  (node.coauthor_producers ?? []).some(coauthor => coauthor.pk === targetId);

/** A Sidecar's complete, distinct child set, or undefined when it does not match its count. */
function exactChildren(node: PostNode) {
  const children = node.carousel_media ?? [];
  const exact =
    children.length > 0 &&
    children.length === node.carousel_media_count &&
    children.every(child => isMediaId(child.pk)) &&
    new Set(children.map(child => child.pk)).size === children.length;
  return exact
    ? children.map(child => ({ mediaId: child.pk, mediaType: MEDIA_TYPE[child.media_type] }))
    : undefined;
}

/**
 * A node's exact reference, or the rule it breaks: another account's Post, a publication time in
 * the future, an inexact identity, or a Sidecar whose children are not exact.
 */
function toRef(
  node: PostNode,
  targetId: string,
  nowSeconds: number
): Either.Either<TimedRef, CheckIncompleteReason> {
  if (!belongsTo(node, targetId)) return Either.left('foreign-owner');
  if (node.taken_at > nowSeconds + CLOCK_SKEW_SECONDS) return Either.left('future-timestamp');
  const { pk: mediaId, code: shortcode } = node;
  if (!isMediaId(mediaId) || !isShortcode(shortcode)) return Either.left('inexact-identity');
  const base = { mediaId, shortcode, takenAt: node.taken_at };
  if (node.media_type !== 8)
    return Either.right({ _tag: 'Post', ...base, mediaType: MEDIA_TYPE[node.media_type] });
  const children = exactChildren(node);
  return children
    ? Either.right({ _tag: 'Sidecar', ...base, children })
    : Either.left('inexact-sidecar');
}

const incomplete = (reason: CheckIncompleteReason) => new AnswerUntrusted({ reason });

/**
 * Whether a page reads as part of one list: distinct items, and a cursor whenever it claims more.
 * Instagram's grid is not newest first: pinned Posts lead it, and older Posts can sit above newer.
 */
const consistent = (refs: readonly TimedRef[], next: string | undefined) =>
  new Set(refs.map(ref => ref.mediaId)).size === refs.length &&
  (next === undefined || (next !== '' && refs.length > 0));

/**
 * Reads one Posts page of `targetId`. Only an answer that does not decode is an unknown format.
 * A GraphQL error, or a node that is not the target's with trustworthy identity and timing,
 * leaves the check incomplete and names the rule that stopped it.
 */
export const readPostsPage = (raw: unknown, targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    if (isErrored(raw)) return yield* Effect.fail(incomplete('graphql-errors'));
    const decoded = yield* Schema.decodeUnknown(PostsResponse)(raw).pipe(
      Effect.mapError(() => new ResponseShapeUnknown({ context: 'watch_posts' }))
    );
    const connection = decoded.data.xdt_api__v1__feed__user_timeline_graphql_connection;
    const refs = yield* Either.all(
      connection.edges.map(edge => toRef(edge.node, targetId, nowSeconds))
    ).pipe(Either.mapLeft(incomplete));
    const { end_cursor: cursor, has_next_page: more } = connection.page_info;
    const next = more ? (cursor ?? '') : undefined;
    if (!consistent(refs, next)) return yield* Effect.fail(incomplete('inconsistent-page'));
    return { refs, next } satisfies PostsPage;
  });

const RELAY_FLAGS = {
  __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
};

/** The first page and cursor pages are separate queries with the same answer shape. */
function pageRequest(username: string, after: string | undefined) {
  const data = {
    count: PAGE_SIZE,
    include_reel_media_seen_timestamp: true,
    include_relationship_info: true,
    latest_besties_reel_media: true,
    latest_reel_media: true,
  };
  if (!after)
    return {
      operation: protocolConfig.operations.profilePosts,
      variables: { data, username, ...RELAY_FLAGS },
    };
  return {
    operation: protocolConfig.operations.profilePostsPage,
    variables: {
      after,
      before: null,
      data,
      first: PAGE_SIZE,
      include_multi_captions: true,
      last: null,
      username,
      ...RELAY_FLAGS,
    },
  };
}

/** Requests one page of the account's Posts by its verified current username. */
export const fetchPostsPage = (username: string, after: string | undefined) =>
  Effect.gen(function* () {
    const { operation, variables } = pageRequest(
      Schema.decodeUnknownSync(InstagramUsername)(username),
      after
    );
    const candidate = operation.candidates[0]!;
    const request = candidate.requests[0]!;
    const csrfToken = yield* readCsrfToken;
    const requests = yield* InstagramRequests;
    const response = yield* requests.fetch(request.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        ...IG_API_GRAPHQL_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
      },
      body: new URLSearchParams({
        [candidate.kind]: candidate.id,
        variables: JSON.stringify(variables),
      }),
    });
    return yield* readJson(response);
  });

const TRAVERSALS_KEY = 'watch-posts-traversals';

/**
 * A Posts traversal in progress, checkpointed after every page in session storage only. A browser
 * restart drops it, and the next turn starts the traversal again from the newest page.
 */
const Traversal = Schema.Struct({
  /** The oldest publication second still eligible, frozen when the traversal started. */
  windowStart: Schema.Number,
  next: Schema.String,
  /** Every cursor this traversal has followed, so a repeat is caught. */
  cursors: Schema.Array(Schema.String),
  /** Every media this traversal has read, so a repeat is caught. */
  media: Schema.Array(MediaId),
});
export type Traversal = Schema.Schema.Type<typeof Traversal>;

const Traversals = Schema.Record({ key: Schema.String, value: Traversal });

const loadTraversals = async () => {
  const stored = await browser.sessionStorage
    .get(TRAVERSALS_KEY)
    .catch((): Record<string, unknown> => ({}));
  const decoded = Schema.decodeUnknownOption(Traversals)(stored[TRAVERSALS_KEY]);
  return decoded._tag === 'Some' ? decoded.value : {};
};

/** The checkpointed traversal of `watchId`, if this browser session has one. */
export const loadTraversal = (watchId: string) =>
  Effect.promise(async () => (await loadTraversals())[watchId]);

/** Checkpoints `watchId`'s traversal, or forgets it when `traversal` is undefined. */
export const saveTraversal = (watchId: string, traversal: Traversal | undefined) =>
  Effect.promise(async () => {
    const others = Object.entries(await loadTraversals()).filter(([id]) => id !== watchId);
    const next = Object.fromEntries(traversal ? [...others, [watchId, traversal]] : others);
    await browser.sessionStorage.set({ [TRAVERSALS_KEY]: next }).catch(() => undefined);
  });

/** The traversal after `page`, which continues at its cursor. */
export const advance = (
  traversal: Traversal | undefined,
  page: { readonly refs: readonly TimedRef[]; readonly next: string },
  windowStart: number
): Traversal => ({
  windowStart,
  next: page.next,
  cursors: [...(traversal?.cursors ?? []), page.next],
  media: [...(traversal?.media ?? []), ...page.refs.map(ref => ref.mediaId)],
});

/** Checks that `page` continues `traversal`: a new cursor, and no media it has already read. */
export const continues = (traversal: Traversal | undefined, page: PostsPage) =>
  !traversal ||
  (!(page.next && traversal.cursors.includes(page.next)) &&
    !page.refs.some(ref => traversal.media.includes(ref.mediaId)));
