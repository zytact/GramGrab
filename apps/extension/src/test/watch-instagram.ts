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

/**
 * A fake of the Instagram endpoints Watches call. Tests change `state` to model a different
 * login, a rename, a lookup Instagram refuses, or the target's current Stories.
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
  };

  const variable = (query: URLSearchParams) =>
    String(JSON.parse(query.get('variables') ?? '{}').reel_ids?.[0]);
  const formDocument = (init?: RequestInit) =>
    init?.body instanceof URLSearchParams ? init.body.get('doc_id') : null;

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
