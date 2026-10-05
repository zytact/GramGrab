import { Effect, Either, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createExtensionHarness, json, type ExtensionHarness } from '../test/extension-harness.ts';

let harness: ExtensionHarness;
const savedBrowser = globalThis.browser;
const savedFetch = globalThis.fetch;

beforeEach(() => {
  harness = createExtensionHarness();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.browser = savedBrowser;
  globalThis.fetch = savedFetch;
});

const LedgerSnapshot = Schema.Struct({
  attempts: Schema.Array(Schema.Number),
  nextWatchAt: Schema.Number,
  pause: Schema.optional(Schema.Struct({ until: Schema.Number, level: Schema.Number })),
});

const ledger = async () =>
  Schema.decodeUnknownSync(LedgerSnapshot)(
    (await harness.local.get('instagram-requests'))['instagram-requests']
  );

const instagramCalls = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.filter(([input]) =>
      new URL(typeof input === 'string' ? input : 'about:blank').hostname.endsWith('instagram.com')
    );

describe('Instagram request accounting', () => {
  const settled = async <T>(operation: Promise<T>): Promise<T> => {
    let done = false;
    void operation.finally(() => (done = true));
    for (let tick = 0; tick < 60 && !done; tick++) await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
    return operation;
  };

  it('counts every helper request and automatic retry of a requested operation', async () => {
    vi.useFakeTimers();
    harness.setFetch(url =>
      url === 'https://www.instagram.com/'
        ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
        : new Response('unavailable', { status: 503 })
    );
    await harness.loadWorker();

    const response = await settled(
      harness.send<{ failure?: { code: string } }>({
        type: 'FETCH_MEDIA',
        url: 'https://www.instagram.com/stories/highlights/17900000000000000/',
      })
    );

    expect(response.failure?.code).toBe('SOURCE_SERVER_FAILED');
    const calls = instagramCalls();
    expect(calls.some(([input]) => input === 'https://www.instagram.com/')).toBe(true);
    expect(calls.length).toBeGreaterThan(4);
    expect((await ledger()).attempts).toHaveLength(calls.length);
  });

  it('counts failed attempts and leaves CDN transfers out', async () => {
    vi.useFakeTimers();
    harness.setFetch(url => {
      if (url.includes('fbcdn.net')) return new Response(new Blob(['x']));
      throw new TypeError('Failed to fetch');
    });
    await harness.loadWorker();

    await settled(
      harness.send({ type: 'FETCH_MEDIA', url: 'https://www.instagram.com/p/DAbcdefghij/' })
    );
    const instagramAttempts = instagramCalls().length;
    await harness.send({
      type: 'GET_PREVIEW_URL',
      url: 'https://scontent.cdninstagram.fbcdn.net/v/t51/a.jpg',
    });

    expect(instagramAttempts).toBeGreaterThan(0);
    expect((await ledger()).attempts).toHaveLength(instagramAttempts);
  });

  it('keeps requested results unchanged', async () => {
    const fixture = (await import('../effect/__fixtures__/shortcode-rest-video.json')).default;
    harness.setFetch(() => json(fixture));
    await harness.loadWorker();

    const response = await harness.send<{ media?: readonly { type: string }[] }>({
      type: 'FETCH_MEDIA',
      url: `https://www.instagram.com/p/${fixture.items[0]!.code}/`,
    });

    expect(response.media?.map(item => item.type)).toEqual(['video']);
  });
});

describe('Watch request admission', () => {
  const runWatch = async (url: string) => {
    const { WatchRequests, InstagramRequests } = await import('./requests.ts');
    return Effect.runPromise(
      Effect.flatMap(InstagramRequests, requests => requests.fetch(url)).pipe(
        Effect.either,
        Effect.provide(WatchRequests)
      )
    );
  };

  const runPerson = async (url: string) => {
    const { PersonRequests, InstagramRequests } = await import('./requests.ts');
    return Effect.runPromise(
      Effect.flatMap(InstagramRequests, requests => requests.fetch(url)).pipe(
        Effect.provide(PersonRequests)
      )
    );
  };

  it('starts no Watch request while person-initiated work is in flight', async () => {
    vi.useFakeTimers();
    let releasePerson: (response: Response) => void = () => undefined;
    harness.setFetch(url =>
      url.endsWith('/person')
        ? new Promise<Response>(resolve => (releasePerson = resolve))
        : json({ ok: true })
    );
    await harness.loadWorker();

    const person = runPerson('https://www.instagram.com/person');
    await vi.advanceTimersByTimeAsync(0);
    const watch = runWatch('https://www.instagram.com/watch');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(instagramCalls().map(([input]) => input)).toEqual(['https://www.instagram.com/person']);

    releasePerson(json({ ok: true }));
    await person;
    await vi.advanceTimersByTimeAsync(19_000);
    expect(instagramCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_000);

    expect(Either.isRight(await watch)).toBe(true);
    expect(instagramCalls()).toHaveLength(2);
  });

  it('never holds person-initiated requests behind Watch work', async () => {
    vi.useFakeTimers();
    let releaseWatch: (response: Response) => void = () => undefined;
    harness.setFetch(url =>
      url.endsWith('/watch')
        ? new Promise<Response>(resolve => (releaseWatch = resolve))
        : json({ ok: true })
    );
    await harness.loadWorker();

    const watch = runWatch('https://www.instagram.com/watch');
    await vi.advanceTimersByTimeAsync(0);
    const person = await runPerson('https://www.instagram.com/person');

    expect(person.ok).toBe(true);
    releaseWatch(json({ ok: true }));
    expect(Either.isRight(await watch)).toBe(true);
  });

  it('pauses Watch work after any 429 and lets one probe end the pause', async () => {
    vi.useFakeTimers();
    let status = 429;
    harness.setFetch(() => new Response('{}', { status }));
    await harness.loadWorker();

    await runPerson('https://www.instagram.com/person');
    const deferred = await runWatch('https://www.instagram.com/watch');
    expect(Either.isLeft(deferred) && deferred.left._tag === 'WatchRequestDeferred').toBe(true);
    if (Either.isLeft(deferred) && deferred.left._tag === 'WatchRequestDeferred')
      expect(deferred.left.until - Date.now()).toBe(30 * 60_000);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await runWatch('https://www.instagram.com/watch');
    expect(((await ledger()).pause?.until ?? 0) - Date.now()).toBe(60 * 60_000);

    status = 200;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(Either.isRight(await runWatch('https://www.instagram.com/watch'))).toBe(true);
    expect((await ledger()).pause?.until).toBeUndefined();

    // The probe reset the backoff, so the next 429 pauses for the base 30 minutes again.
    status = 429;
    await vi.advanceTimersByTimeAsync(60_000);
    await runWatch('https://www.instagram.com/watch');
    expect(((await ledger()).pause?.until ?? 0) - Date.now()).toBe(30 * 60_000);
  });

  it('stops a helper from retrying past the shared pause', async () => {
    vi.useFakeTimers();
    harness.setFetch(() => new Response('{}', { status: 429 }));
    await harness.loadWorker();
    const { WatchRequests } = await import('./requests.ts');
    const { graphqlFetch } = await import('../effect/instagram.ts');

    const result = Effect.runPromise(
      graphqlFetch('https://www.instagram.com/graphql/query/', 'doc_id', '1', {}, {}).pipe(
        Effect.either,
        Effect.provide(WatchRequests)
      )
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await result;

    expect(instagramCalls()).toHaveLength(1);
    expect(Either.isLeft(outcome) && outcome.left._tag).toBe('WatchRequestDeferred');
  });

  it('recovers an expired probe after the worker reloads', async () => {
    vi.useFakeTimers();
    harness.local.write('instagram-requests', {
      version: 1,
      attempts: [],
      nextWatchAt: 0,
      pause: { until: Date.now() - 1, level: 1, probing: true },
    });
    harness.setFetch(() => json({}));
    await harness.loadWorker();

    expect(Either.isRight(await runWatch('https://www.instagram.com/watch'))).toBe(true);
    expect(instagramCalls()).toHaveLength(1);
    expect((await ledger()).pause).toBeUndefined();
  });

  it.each([503, 'network'])('preserves backoff after a failed probe: %s', async failure => {
    vi.useFakeTimers();
    harness.local.write('instagram-requests', {
      version: 1,
      attempts: [],
      nextWatchAt: 0,
      pause: { until: Date.now() - 1, level: 1 },
    });
    harness.setFetch(() => {
      if (typeof failure === 'string') throw new TypeError('Failed to fetch');
      return new Response('{}', { status: failure });
    });
    await harness.loadWorker();
    await runWatch('https://www.instagram.com/watch');
    expect((await ledger()).pause?.level).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    harness.setFetch(() => new Response('{}', { status: 429 }));
    await runWatch('https://www.instagram.com/watch');
    expect((await ledger()).pause).toMatchObject({
      level: 2,
      until: Date.now() + 2 * 60 * 60_000,
    });
  });

  it('holds Watch work once the rolling hour has 60 attempts, including person requests', async () => {
    vi.useFakeTimers();
    harness.setFetch(() => json({}));
    await harness.loadWorker();
    for (let index = 0; index < 60; index++) await runPerson('https://www.instagram.com/person');

    const deferred = await runWatch('https://www.instagram.com/watch');

    expect(Either.isLeft(deferred) && deferred.left._tag).toBe('WatchRequestDeferred');
    if (Either.isLeft(deferred) && deferred.left._tag === 'WatchRequestDeferred')
      expect(deferred.left.until).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect((await ledger()).attempts).toHaveLength(60);
  });
});
