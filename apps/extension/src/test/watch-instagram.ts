import { json } from './extension-harness.ts';

export const VIEWER = { id: '1001', username: 'viewer.one' };
export const TARGET = { id: '2002', username: 'target.one' };

/**
 * A fake of the Instagram identity endpoints a Watch command calls. Tests change `viewer`,
 * `profile`, or `accounts` to model a different login, a rename, or a lookup Instagram refuses.
 */
export function createWatchInstagram() {
  const state = {
    viewer: VIEWER as { id: string; username: string } | null,
    profile: {
      data: { user: { id: TARGET.id, pk: TARGET.id, username: TARGET.username } },
    } as Record<string, unknown>,
    accounts: { [TARGET.username]: { id: TARGET.id } } as Record<string, { id: string }>,
  };

  function handle(url: string, init?: RequestInit): Response {
    const parsed = new URL(url);
    if (parsed.searchParams.get('query_hash') === 'd6f4427fbe92d846298cf93df0b937d3')
      return state.viewer ? json({ data: { user: state.viewer } }) : json({}, 401);
    if (parsed.pathname === '/api/v1/users/web_profile_info/')
      return json({ data: { user: state.accounts[parsed.searchParams.get('username') ?? ''] } });
    if (
      init?.method === 'POST' &&
      init.body instanceof URLSearchParams &&
      init.body.get('doc_id') === '28036671149327607'
    )
      return json(state.profile);
    return json({}, 404);
  }

  return { state, handle };
}
