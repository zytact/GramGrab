import { Data, Effect, Schema } from 'effect';
import { InstagramUsername } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { IG_API_GRAPHQL_HEADERS, readCsrfToken } from '../instagram/acquisition.ts';
import { InstagramRequests } from '../instagram/requests.ts';
import { ResponseShapeUnknown } from '../effect/errors.ts';
import { MediaId, Shortcode, type TimedRef } from './contracts.ts';
import { readJson } from './identity.ts';

/** Instagram's answer was valid but cannot be trusted as a complete, ordered traversal. */
export class PostsIncomplete extends Data.TaggedError('PostsIncomplete') {}

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
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});

export interface PostsPage {
  readonly refs: readonly TimedRef[];
  /** The cursor of the next page, or undefined when Instagram says the list ended. */
  readonly next: string | undefined;
}

const MEDIA_TYPE = { 1: 'image', 2: 'video' } as const;

const isMediaId = Schema.is(MediaId);
const isShortcode = Schema.is(Shortcode);

/**
 * A node's exact reference, or undefined when its identity is not exact. A Sidecar keeps its
 * complete, distinct child set, which must match its declared count.
 */
function toRef(node: PostNode): TimedRef | undefined {
  const { pk: mediaId, code: shortcode } = node;
  if (!isMediaId(mediaId) || !isShortcode(shortcode)) return undefined;
  const base = { mediaId, shortcode, takenAt: node.taken_at };
  if (node.media_type !== 8)
    return { _tag: 'Post', ...base, mediaType: MEDIA_TYPE[node.media_type] };
  const children = node.carousel_media ?? [];
  if (children.length === 0 || children.length !== node.carousel_media_count) return undefined;
  if (!children.every(child => isMediaId(child.pk))) return undefined;
  if (new Set(children.map(child => child.pk)).size !== children.length) return undefined;
  return {
    _tag: 'Sidecar',
    ...base,
    children: children.map(child => ({
      mediaId: child.pk,
      mediaType: MEDIA_TYPE[child.media_type],
    })),
  };
}

/** A collab Post lists the target as a co-author while another account owns it. */
const belongsTo = (node: PostNode, targetId: string) =>
  node.user.pk === targetId ||
  (node.coauthor_producers ?? []).some(coauthor => coauthor.pk === targetId);

const untrusted = () => new ResponseShapeUnknown({ context: 'watch_posts' });

/**
 * Whether a page reads as part of one list: distinct items, and a cursor whenever it claims more.
 * Instagram's grid is not newest first: pinned Posts lead it, and older Posts can sit above newer.
 */
const consistent = (refs: readonly TimedRef[], next: string | undefined) =>
  new Set(refs.map(ref => ref.mediaId)).size === refs.length &&
  (next === undefined || (next !== '' && refs.length > 0));

/**
 * Reads one Posts page of `targetId`. Every node must be authored or co-authored by the target,
 * and carry trustworthy identity and timing; any GraphQL error fails the page.
 */
export const readPostsPage = (raw: unknown, targetId: string, nowSeconds: number) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknown(PostsResponse)(raw).pipe(
      Effect.mapError(untrusted)
    );
    if ((decoded.errors?.length ?? 0) > 0) return yield* Effect.fail(untrusted());
    const connection = decoded.data.xdt_api__v1__feed__user_timeline_graphql_connection;
    const nodes = connection.edges.map(edge => edge.node);
    const trusted = nodes.every(
      node => belongsTo(node, targetId) && node.taken_at <= nowSeconds + CLOCK_SKEW_SECONDS
    );
    const refs = nodes.map(toRef).filter(ref => ref !== undefined);
    if (!trusted || refs.length !== nodes.length) return yield* Effect.fail(untrusted());
    const { end_cursor: cursor, has_next_page: more } = connection.page_info;
    const next = more ? (cursor ?? '') : undefined;
    if (!consistent(refs, next)) return yield* Effect.fail(new PostsIncomplete());
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
    return yield* readJson(response, 'watch_posts');
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
