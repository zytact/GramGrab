import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { Effect, Either } from 'effect';
import { InstagramRequests } from '../instagram/requests.ts';
import { browser } from '../lib/browser.ts';
import { homePage } from '../test/watch-instagram.ts';
import { fetchViewer, recentViewer } from './identity.ts';

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

describe('recentViewer', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers from the last read only while the session cookie is unchanged and recent', async () => {
    vi.useFakeTimers();
    let session = 'session-a';
    vi.spyOn(browser.cookies, 'get').mockImplementation(async () => ({ value: session }));
    let reads = 0;
    const as = <A, E>(effect: Effect.Effect<A, E, InstagramRequests>) =>
      effect.pipe(
        Effect.provideService(InstagramRequests, {
          login: 'main',
          fetch: () =>
            Effect.sync(() => (reads++, homePage({ id: '1001', username: 'instagram' }))),
        }),
        Effect.runPromise
      );

    await as(fetchViewer);
    expect(await as(recentViewer)).toMatchObject({ accountId: '1001' });
    expect(reads).toBe(1);

    session = 'session-b';
    await as(recentViewer);
    expect(reads).toBe(2);

    vi.advanceTimersByTime(5 * 60_000);
    await as(recentViewer);
    expect(reads).toBe(3);

    await as(fetchViewer);
    expect(reads).toBe(4);
  });

  it('stops downloading the home page once it names the token and the viewer', async () => {
    const head = await homePage({ id: '1001', username: 'instagram' }).text();
    const encoder = new TextEncoder();
    let sentHead = false;
    const cancel = vi.fn();
    const endless = new ReadableStream<Uint8Array>({
      pull: controller => {
        controller.enqueue(encoder.encode(sentHead ? '<div></div>'.repeat(1000) : head));
        sentHead = true;
      },
      cancel,
    });
    const viewer = await fetchViewer.pipe(
      Effect.provideService(InstagramRequests, {
        login: 'main',
        fetch: () => Effect.succeed(new Response(endless)),
      }),
      Effect.runPromise
    );

    expect(viewer).toMatchObject({ accountId: '1001' });
    expect(cancel).toHaveBeenCalled();
  });
});
