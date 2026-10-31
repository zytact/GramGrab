import { describe, expect, it } from 'vite-plus/test';
import { Effect, Either } from 'effect';
import { InstagramRequests } from '../instagram/requests.ts';
import { fetchViewer } from './identity.ts';

const viewerOn = (page: string) =>
  fetchViewer.pipe(
    Effect.either,
    Effect.provideService(InstagramRequests, {
      login: 'main',
      fetch: () => Effect.succeed(new Response(page, { headers: { 'Content-Type': 'text/html' } })),
    }),
    Effect.runPromise
  );

describe('fetchViewer', () => {
  it('reads the viewer from a PolarisViewer block with nested objects and braces in strings', async () => {
    const data = {
      biography: 'a } "quoted" { bio',
      linked_fb_info: { linked_fb_user: { name: '}' } },
      id: '1001',
      profile_pic_url: 'https://sanitized.invalid/a.jpg',
      username: 'instagram',
    };
    const page = `<script>["PolarisViewer",[],${JSON.stringify({ data, id: '1001' })},7365]</script>`;

    expect(await viewerOn(page)).toEqual(
      Either.right({
        accountId: '1001',
        username: 'instagram',
        pictureUrl: 'https://sanitized.invalid/a.jpg',
      })
    );
  });

  it('fails as ViewerMissing when the page names no viewer', async () => {
    const result = await viewerOn('["PolarisViewer",[],{"data":null,"id":null},7365]');
    expect(result).toMatchObject({ left: { _tag: 'ViewerMissing' } });
  });

  it.each([
    ['has no PolarisViewer block', '<html></html>'],
    ['has a block that does not decode', '["PolarisViewer",[],{"data":{"id":"1001"},"id":"1001"}]'],
    ['has a block that never closes', '["PolarisViewer",[],{"data":{"id":"1001"'],
  ])('reports a format change for a page that %s', async (_case, page) => {
    expect(await viewerOn(page)).toMatchObject({
      left: { _tag: 'ResponseShapeUnknown', context: 'watch_viewer' },
    });
  });
});
