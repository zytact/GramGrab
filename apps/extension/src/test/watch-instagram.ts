import instantPhoto from '../effect/__fixtures__/instants-photo.json';
import instantVideo from '../effect/__fixtures__/instants-video.json';
import postsFixture from '../effect/__fixtures__/profile-posts.json';
import storyFixture from '../effect/__fixtures__/story.json';
import { json } from './extension-harness.ts';

export const VIEWER = { id: '1001', username: 'viewer.one' };
export const TARGET = { id: '2002', username: 'target.one' };

export interface FakeStory {
  readonly id: string;
  readonly video?: boolean;
  readonly takenAt: number;
  readonly expiresAt?: number;
}

/**
 * A Story response in the shape of the sanitized `story.json` capture, with numeric identities in
 * place of its sanitized tokens so Watch acquisition can accept it.
 */
export function storyResponse(targetId: string, stories: readonly FakeStory[]) {
  const [reel] = storyFixture.data.reels_media;
  const [item] = reel!.items;
  return {
    data: {
      reels_media: [
        {
          ...reel,
          id: targetId,
          owner: { ...reel!.owner, id: targetId },
          user: { ...reel!.user, id: targetId },
          items: stories.map(story => ({
            ...item,
            __typename: story.video === false ? 'GraphStoryImage' : 'GraphStoryVideo',
            is_video: story.video !== false,
            id: story.id,
            owner: { ...item!.owner, id: targetId },
            taken_at_timestamp: story.takenAt,
            expiring_at_timestamp: story.expiresAt ?? story.takenAt + 86_400,
          })),
        },
      ],
    },
    errors: storyFixture.errors,
  };
}

export interface FakePost {
  readonly id: string;
  readonly takenAt: number;
  readonly video?: boolean;
  /** Sidecar children by ID; a Post without them is a single image or video. */
  readonly children?: readonly string[];
  readonly owner?: string;
}

const POSTS_ROOT = 'xdt_api__v1__feed__user_timeline_graphql_connection';

/**
 * A Posts page in the shape of the sanitized `profile-posts.json` capture, with numeric identities
 * in place of its sanitized tokens. `next` is the cursor of the following page; omitting it ends
 * the list.
 */
export function postsPage(posts: readonly FakePost[], next?: string) {
  const connection = postsFixture.data[POSTS_ROOT];
  const sidecar = connection.edges.find(edge => edge.node.media_type === 8)!.node;
  return {
    data: {
      [POSTS_ROOT]: {
        edges: posts.map(post => ({
          node: {
            ...sidecar,
            pk: post.id,
            code: `C${post.id}`,
            taken_at: post.takenAt,
            user: { ...sidecar.user, pk: post.owner ?? TARGET.id, id: post.owner ?? TARGET.id },
            media_type: post.children ? 8 : post.video === false ? 1 : 2,
            carousel_media_count: post.children?.length ?? null,
            carousel_media:
              post.children?.map((id, index) => ({ pk: id, media_type: index === 0 ? 1 : 2 })) ??
              null,
          },
        })),
        page_info: { ...connection.page_info, end_cursor: next ?? null, has_next_page: !!next },
      },
    },
  };
}

export interface FakeInstant {
  /** The media part of the ID; the owner part is appended. */
  readonly pk: string;
  readonly owner: string;
  readonly takenAt: number;
  readonly video?: boolean;
}

/**
 * An Instants feed in the shape of the sanitized `instants-*.json` captures, with numeric
 * owner-bound identities in place of their sanitized tokens.
 */
export function instantsFeed(instants: readonly FakeInstant[]) {
  const [photo] = instantPhoto.data.xdt_get_quick_snaps.items_ordered_by_time;
  const [video] = instantVideo.data.xdt_get_quick_snaps.items_ordered_by_time;
  return {
    data: {
      xdt_get_quick_snaps: {
        ...instantPhoto.data.xdt_get_quick_snaps,
        items_ordered_by_time: instants.map(instant => {
          const item = instant.video ? video! : photo!;
          return {
            ...item,
            id: `${instant.pk}_${instant.owner}`,
            taken_at: instant.takenAt,
            user: { ...item.user, id: instant.owner },
          };
        }),
        sample_items: [],
      },
    },
  };
}

/**
 * A fake of the Instagram endpoints Watches call. Tests change `state` to model a different
 * login, a rename, a lookup Instagram refuses, or the target's current Stories, Posts pages, and
 * the viewer's Instants feed.
 */
export function createWatchInstagram() {
  const state = {
    viewer: VIEWER as { id: string; username: string } | null,
    profile: {
      data: { user: { id: TARGET.id, pk: TARGET.id, username: TARGET.username } },
    } as Record<string, unknown>,
    accounts: { [TARGET.username]: { id: TARGET.id } } as Record<string, { id: string }>,
    /** The raw Story answer per target ID; absent targets get an identified empty reel. */
    stories: {} as Record<string, unknown>,
    storyStatus: 200,
    /** Posts answers by the cursor that requests them; the first page is under ''. */
    posts: { '': postsPage([]) } as Record<string, unknown>,
    /** The cursor of every Posts page requested, '' for the first page. */
    postRequests: [] as string[],
    instants: instantsFeed([]) as unknown,
    instantsRequests: 0,
  };

  const variable = (query: URLSearchParams) =>
    String(JSON.parse(query.get('variables') ?? '{}').reel_ids?.[0]);
  const formDocument = (init?: RequestInit) =>
    init?.body instanceof URLSearchParams ? init.body.get('doc_id') : null;

  const postsAnswer = (init: RequestInit | undefined, cursorPage: boolean) => {
    const body = init?.body as URLSearchParams;
    const cursor = cursorPage ? String(JSON.parse(body.get('variables') ?? '{}').after) : '';
    state.postRequests.push(cursor);
    return json(state.posts[cursor] ?? {}, cursor in state.posts ? 200 : 404);
  };

  /** Each route answers one endpoint the Watch code calls; the first match wins. */
  const routes: readonly ((url: URL, init?: RequestInit) => Response | undefined)[] = [
    ({ searchParams }) =>
      searchParams.get('query_hash') === 'd6f4427fbe92d846298cf93df0b937d3'
        ? state.viewer
          ? json({ data: { user: state.viewer } })
          : json({}, 401)
        : undefined,
    ({ searchParams }) => {
      if (searchParams.get('query_hash') !== '45246d3fe16ccc6577e0bd297a5db1ab') return undefined;
      const targetId = variable(searchParams);
      return json(state.stories[targetId] ?? storyResponse(targetId, []), state.storyStatus);
    },
    ({ pathname, searchParams }) =>
      pathname === '/api/v1/users/web_profile_info/'
        ? json({ data: { user: state.accounts[searchParams.get('username') ?? ''] } })
        : undefined,
    (_url, init) => (formDocument(init) === '28036671149327607' ? json(state.profile) : undefined),
    (_url, init) =>
      formDocument(init) === '28991540097136703' ? postsAnswer(init, false) : undefined,
    (_url, init) =>
      formDocument(init) === '29240983615539641' ? postsAnswer(init, true) : undefined,
    (_url, init) => {
      if (!(init?.body instanceof URLSearchParams)) return undefined;
      if (init.body.get('client_doc_id') !== '13779138904809319315782061537') return undefined;
      state.instantsRequests += 1;
      return json(state.instants);
    },
    // The configured primary Story request answered 403 in every live probe.
    (_url, init) =>
      formDocument(init) === '28299494542988937' ? new Response('', { status: 403 }) : undefined,
  ];

  const handle = (url: string, init?: RequestInit): Response => {
    const parsed = new URL(url);
    for (const route of routes) {
      const response = route(parsed, init);
      if (response) return response;
    }
    return json({}, 404);
  };

  return { state, handle };
}
