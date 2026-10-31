import { vi } from 'vite-plus/test';
import instantPhoto from '../effect/__fixtures__/instants-photo.json';
import instantVideo from '../effect/__fixtures__/instants-video.json';
import postsFixture from '../effect/__fixtures__/profile-posts.json';
import restVideoFixture from '../effect/__fixtures__/shortcode-rest-video.json';
import storyFixture from '../effect/__fixtures__/story.json';
import { protocolConfig } from '../instagram-protocol/config.ts';
import { shortcodeMediaId } from '../instagram/rest-shortcode.ts';
import { json } from './extension-harness.ts';

export const VIEWER = { id: '1001', username: 'instagram' };
export const TARGET = { id: '2002', username: 'instagram' };

type FakeViewer = { id: string; username: string; profile_pic_url?: string };

/** Instagram Web's home page, naming its `fb_dtsg` token and the signed-in viewer, or none. */
export const homePage = (viewer: FakeViewer | null, token = 'DTSG_A') =>
  new Response(
    `<script>["DTSGInitialData",[],{"token":"${token}"},258],` +
      `["PolarisViewer",[],${JSON.stringify({ data: viewer, id: viewer?.id ?? null })},7365]</script>`,
    { headers: { 'Content-Type': 'text/html' } }
  );

/** Whether `url` reads Instagram Web's home page, where Watches learn the signed-in viewer. */
export const isHomePage = (url: string) => {
  const { hostname, pathname } = new URL(url);
  return hostname === 'www.instagram.com' && pathname === '/';
};

export interface FakeStory {
  readonly id: string;
  readonly video?: boolean;
  readonly takenAt: number;
  readonly expiresAt?: number;
}

/** The reel a Story request asks for and the token it sent, or undefined for any other request. */
export function storyRequest(init?: RequestInit) {
  const body = init?.body instanceof URLSearchParams ? init.body : undefined;
  if (body?.get('doc_id') !== protocolConfig.operations.reelsMedia.candidates[0]!.id) return;
  const reelId = String(JSON.parse(body.get('variables') ?? '{}').reel_ids_arr[0]);
  return { reelId, dtsgToken: body.get('fb_dtsg') };
}

/** Instagram's answer for an account without active Stories. */
export const NO_STORIES = { data: { xdt_api__v1__feed__reels_media: { reels_media: [] } } };

/**
 * A Story response in the shape of the sanitized `story.json` capture, with numeric identities in
 * place of its sanitized tokens so Watch acquisition can accept it.
 */
export function storyResponse(targetId: string, stories: readonly FakeStory[]) {
  const [reel] = storyFixture.data.xdt_api__v1__feed__reels_media.reels_media;
  const image = reel!.items.find(item => item.media_type === 1)!;
  const video = reel!.items.find(item => item.media_type === 2)!;
  return {
    data: {
      xdt_api__v1__feed__reels_media: {
        reels_media: [
          {
            ...reel,
            id: targetId,
            user: { ...reel!.user, pk: targetId, id: targetId },
            items: stories.map(story => ({
              ...(story.video === false ? image : video),
              id: `${story.id}_${targetId}`,
              pk: story.id,
              taken_at: story.takenAt,
              expiring_at: story.expiresAt ?? story.takenAt + 86_400,
            })),
          },
        ],
      },
    },
  };
}

export interface FakePost {
  readonly id: string;
  readonly takenAt: number;
  readonly video?: boolean;
  /** Sidecar children by ID; a Post without them is a single image or video. */
  readonly children?: readonly string[];
  readonly owner?: string;
  readonly coauthors?: readonly string[];
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
            coauthor_producers: post.coauthors?.map(pk => ({ pk })) ?? [],
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

/**
 * A REST media answer in the shape of the sanitized `shortcode-rest-video.json` capture for a Post
 * as `postsPage` lists it: the same shortcode, and Sidecar children image first, then videos.
 */
export function restMedia(post: FakePost) {
  const [video] = restVideoFixture.items;
  const coauthor_producers = post.coauthors?.map(pk => ({ pk, id: pk })) ?? [];
  const item = (pk: string, isVideo: boolean) =>
    isVideo
      ? { ...video!, pk, carousel_media: null }
      : { pk, media_type: 1, image_versions2: video!.image_versions2 };
  return {
    status: 'ok',
    items: [
      post.children
        ? {
            pk: post.id,
            code: `C${post.id}`,
            media_type: 8,
            user: { pk: post.owner ?? TARGET.id, id: post.owner ?? TARGET.id },
            coauthor_producers,
            taken_at: post.takenAt,
            carousel_media: post.children.map((id, index) => item(id, index > 0)),
          }
        : {
            ...item(post.id, post.video !== false),
            code: `C${post.id}`,
            taken_at: post.takenAt,
            user: { pk: post.owner ?? TARGET.id, id: post.owner ?? TARGET.id },
            coauthor_producers,
          },
    ],
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
 * An ID-keyed profile answer for one account. A picture ID becomes the asset name of a fresh
 * picture URL, the way Instagram signs every answer anew.
 */
export function avatarProfile(account: {
  readonly id: string;
  readonly username: string;
  readonly pictureId?: string;
}) {
  return {
    data: {
      user: {
        id: account.id,
        pk: account.id,
        username: account.username,
        ...(account.pictureId && {
          profile_pic_url: `https://sanitized.invalid/v/${account.pictureId}.jpg?sig=${Math.random()}`,
        }),
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
    viewer: VIEWER as FakeViewer | null,
    homePageReads: 0,
    profile: avatarProfile({ ...TARGET, pictureId: 'PIC_A' }) as Record<string, unknown>,
    /** The account ID of every ID-keyed profile request. */
    profileRequests: [] as string[],
    /** The account IDs profile pages name, by username. */
    accounts: { [TARGET.username]: { id: TARGET.id } } as Record<string, { id: string }>,
    /** The raw Story answer per target ID; absent targets get Instagram's no-reel answer. */
    stories: {} as Record<string, unknown>,
    storyStatus: 200,
    /**
     * Posts answers by the cursor that requests them; the first page is under ''. A `Response` is
     * served as it is, for a body that is not JSON.
     */
    posts: { '': postsPage([]) } as Record<string, unknown>,
    /** The cursor of every Posts page requested, '' for the first page. */
    postRequests: [] as string[],
    /** The `fb_dtsg` the home page names, and the one each Posts request sent. */
    dtsgToken: 'DTSG_A',
    postTokens: [] as (string | null)[],
    instants: instantsFeed([]) as unknown,
    instantsRequests: 0,
    /** REST media answers by shortcode; any other media is a 404. */
    media: {} as Record<string, unknown>,
    mediaRequests: 0,
  };

  const formDocument = (init?: RequestInit) =>
    init?.body instanceof URLSearchParams ? init.body.get('doc_id') : null;

  const postsAnswer = (init: RequestInit | undefined, cursorPage: boolean) => {
    const body = init?.body as URLSearchParams;
    const cursor = cursorPage ? String(JSON.parse(body.get('variables') ?? '{}').after) : '';
    state.postRequests.push(cursor);
    state.postTokens.push(body.get('fb_dtsg'));
    if (body.get('fb_dtsg') !== state.dtsgToken)
      return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
    const answer = state.posts[cursor];
    if (answer instanceof Response) return answer.clone();
    return json(state.posts[cursor] ?? {}, cursor in state.posts ? 200 : 404);
  };

  /** Each route answers one endpoint the Watch code calls; the first match wins. */
  const routes: readonly ((url: URL, init?: RequestInit) => Response | undefined)[] = [
    // Profile answers carry picture URLs on this host; the Avatar cache loads from it.
    ({ hostname }) =>
      hostname === 'sanitized.invalid'
        ? new Response(new Blob(['picture'], { type: 'image/jpeg' }))
        : undefined,
    (_url, init) => {
      const request = storyRequest(init);
      if (!request) return undefined;
      if (request.dtsgToken !== state.dtsgToken)
        return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
      return json(state.stories[request.reelId] ?? NO_STORIES, state.storyStatus);
    },
    ({ pathname }) => {
      const id = /^\/api\/v1\/media\/(\d+)\/info\/$/.exec(pathname)?.[1];
      if (!id) return undefined;
      state.mediaRequests += 1;
      const code = Object.keys(state.media).find(shortcode => shortcodeMediaId(shortcode) === id);
      return code ? json(state.media[code]) : json({}, 404);
    },
    url => {
      if (!isHomePage(url.href)) return undefined;
      state.homePageReads += 1;
      return homePage(state.viewer, state.dtsgToken);
    },
    ({ hostname, pathname }) => {
      const username = /^\/([^/]+)\/$/.exec(pathname)?.[1];
      if (hostname !== 'www.instagram.com' || !username) return undefined;
      const account = state.accounts[username];
      return account
        ? new Response(`{"profile_id":"${account.id}"}`)
        : new Response('', { status: 404 });
    },
    (_url, init) => {
      if (formDocument(init) !== '28036671149327607') return undefined;
      const body = init?.body as URLSearchParams;
      state.profileRequests.push(String(JSON.parse(body.get('variables') ?? '{}').id));
      return json(state.profile);
    },
    (_url, init) =>
      formDocument(init) === '28991540097136703' ? postsAnswer(init, false) : undefined,
    (_url, init) =>
      formDocument(init) === '29240983615539641' ? postsAnswer(init, true) : undefined,
    ({ pathname }) => {
      if (pathname !== '/graphql_www') return undefined;
      state.instantsRequests += 1;
      return json(state.instants);
    },
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

/**
 * Stands in for the browser's image decoding and canvas, which jsdom lacks. Every scaled picture
 * encodes to the same few JPEG bytes.
 */
export function stubAvatarScaling() {
  vi.stubGlobal('createImageBitmap', async () => ({ width: 150, height: 100, close() {} }));
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
      }
    }
  );
}

/** The data URL `stubAvatarScaling` pictures arrive at the page as. */
export const STUB_AVATAR = 'data:image/jpeg;base64,/9j/2Q==';
