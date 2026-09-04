import { Effect } from 'effect';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  fetchBlobAsDataUrl,
  fetchTopSearchUserId,
  fetchWebProfileInfoUser,
  graphqlFetch,
  graphqlPost,
} from './instagram.ts';
import {
  GraphQLRequestFailed,
  HttpError,
  NetworkError,
  RateLimited,
  ResponseShapeUnknown,
} from './errors.ts';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('graphqlFetch', () => {
  const TEST_URL = 'https://www.instagram.com/graphql/query/';
  const vars = { shortcode: 'abc123' };

  it('returns parsed JSON on success', async () => {
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockData,
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}));
    expect(result).toEqual(mockData);
  });

  it('fails with GraphQLRequestFailed on non-ok non-429 response', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const resultPromise = Effect.runPromise(
      graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}).pipe(Effect.either)
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(GraphQLRequestFailed);
      expect((result.left as GraphQLRequestFailed).status).toBe(500);
    }
  });

  it('fails with RateLimited on 429 response', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }) as unknown as typeof fetch;

    const resultPromise = Effect.runPromise(
      graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}).pipe(Effect.either)
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(RateLimited);
    }
  });

  it('retries and succeeds after a 429 transient failure', async () => {
    vi.useFakeTimers();
    let count = 0;
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    globalThis.fetch = vi.fn().mockImplementation(() => {
      count++;
      if (count === 1) return Promise.resolve({ ok: false, status: 429 });
      return Promise.resolve({ ok: true, status: 200, json: async () => mockData });
    }) as unknown as typeof fetch;

    const resultPromise = Effect.runPromise(
      graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}).pipe(Effect.either)
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result._tag).toBe('Right');
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('retries and succeeds after a 500 transient failure', async () => {
    vi.useFakeTimers();
    let count = 0;
    const mockData = { data: { xdt_shortcode_media: { id: '2' } } };
    globalThis.fetch = vi.fn().mockImplementation(() => {
      count++;
      if (count === 1) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200, json: async () => mockData });
    }) as unknown as typeof fetch;

    const resultPromise = Effect.runPromise(
      graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}).pipe(Effect.either)
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result._tag).toBe('Right');
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it.each([400, 401, 403, 404])(
    'fails immediately on permanent %i without retrying',
    async status => {
      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: false, status });
      }) as unknown as typeof fetch;

      const result = await Effect.runPromise(
        graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}).pipe(Effect.either)
      );
      expect(result._tag).toBe('Left');
      expect(callCount).toBe(1);
      if (result._tag === 'Left') {
        expect(result.left).toBeInstanceOf(GraphQLRequestFailed);
      }
    }
  );

  it('fails with NetworkError when fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      graphqlFetch(TEST_URL, 'doc_id', '12345', vars, {}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(NetworkError);
    }
  });
});

describe('graphqlPost', () => {
  const TEST_URL = 'https://www.instagram.com/api/graphql/';
  const vars = { shortcode: 'abc123' };

  it('posts form-encoded doc_id variables and returns parsed JSON', async () => {
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockData,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    document.body.innerHTML = '<input name="lsd" value="token123" />';

    const result = await Effect.runPromise(
      graphqlPost(TEST_URL, '12345', vars, { 'X-IG-App-ID': 'test-app-id' })
    );

    expect(result).toEqual(mockData);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      TEST_URL,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-IG-App-ID': 'test-app-id',
        }),
        body: expect.any(URLSearchParams),
      })
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body.get('doc_id')).toBe('12345');
    expect(body.get('variables')).toBe(JSON.stringify(vars));
  });

  it('includes an available lsd token in the POST body and header', async () => {
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockData,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    document.body.innerHTML = '<input name="lsd" value="token123" />';

    const result = await Effect.runPromise(graphqlPost(TEST_URL, '12345', vars, {}));

    expect(result).toEqual(mockData);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ 'X-FB-LSD': 'token123' })
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body.get('lsd')).toBe('token123');
  });

  it('fetches an lsd token from Instagram HTML when running without a document', async () => {
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<script>require("LSD",[],{"token":"htmltoken123"},null)</script>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.stubGlobal('document', undefined);

    const result = await Effect.runPromise(graphqlPost(TEST_URL, '12345', vars, {}));

    expect(result).toEqual(mockData);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://www.instagram.com/',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual(
      expect.objectContaining({ 'X-FB-LSD': 'htmltoken123' })
    );
    const body = fetchMock.mock.calls[1]?.[1]?.body;
    expect(body.get('lsd')).toBe('htmltoken123');
  });

  it('fetches an lsd token from Instagram HTML when local document has no token', async () => {
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"lsd":"htmltoken456"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    document.body.innerHTML = '<main></main>';

    const result = await Effect.runPromise(graphqlPost(TEST_URL, '12345', vars, {}));

    expect(result).toEqual(mockData);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://www.instagram.com/',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual(
      expect.objectContaining({ 'X-FB-LSD': 'htmltoken456' })
    );
    const body = fetchMock.mock.calls[1]?.[1]?.body;
    expect(body.get('lsd')).toBe('htmltoken456');
  });

  it('posts without lsd fields when background-safe token lookup finds none', async () => {
    const mockData = { data: { xdt_shortcode_media: { id: '1' } } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '<html></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.stubGlobal('document', undefined);

    const result = await Effect.runPromise(graphqlPost(TEST_URL, '12345', vars, {}));

    expect(result).toEqual(mockData);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty('X-FB-LSD');
    const body = fetchMock.mock.calls[1]?.[1]?.body;
    expect(body.get('lsd')).toBeNull();
  });

  it('fails with GraphQLRequestFailed on non-ok non-429 response', async () => {
    document.body.innerHTML = '<input name="lsd" value="token123" />';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      graphqlPost(TEST_URL, '12345', vars, {}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(GraphQLRequestFailed);
      expect((result.left as GraphQLRequestFailed).status).toBe(403);
    }
  });
});

describe('fetchBlobAsDataUrl', () => {
  it('returns a data URL string on success', async () => {
    const fakeBlob = new Blob(['PNG'], { type: 'image/png' });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => fakeBlob,
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(fetchBlobAsDataUrl('https://cdn.instagram.com/img.png'));
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it('fails with HttpError when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      blob: async () => new Blob(),
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchBlobAsDataUrl('https://cdn.instagram.com/img.png').pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(HttpError);
      expect((result.left as HttpError).status).toBe(403);
    }
  });

  it('fails with NetworkError when fetch throws', async () => {
    const cause = new TypeError('Failed to fetch');
    globalThis.fetch = vi.fn().mockRejectedValue(cause) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchBlobAsDataUrl('https://cdn.instagram.com/img.png').pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(NetworkError);
    }
  });

  it('does not use FileReader (service-worker-safe)', async () => {
    const FileReaderSpy = vi.fn();
    globalThis.FileReader = FileReaderSpy as unknown as typeof FileReader;

    const fakeBlob = new Blob(['data'], { type: 'image/jpeg' });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => fakeBlob,
    }) as unknown as typeof fetch;

    await Effect.runPromise(fetchBlobAsDataUrl('https://cdn.instagram.com/img.jpg'));
    expect(FileReaderSpy).not.toHaveBeenCalled();
  });
});

describe('fetchWebProfileInfoUser', () => {
  const TEST_URL = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=testuser';

  it('returns the decoded user on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { user: { id: '42', profile_pic_url_hd: 'https://cdn.example.com/hd.jpg' } },
      }),
    }) as unknown as typeof fetch;

    const user = await Effect.runPromise(fetchWebProfileInfoUser(TEST_URL, 'include', {}));
    expect(user?.id).toBe('42');
    expect(user?.profile_pic_url_hd).toBe('https://cdn.example.com/hd.jpg');
  });

  it('returns undefined user when data is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const user = await Effect.runPromise(fetchWebProfileInfoUser(TEST_URL, 'include', {}));
    expect(user).toBeUndefined();
  });

  it('fails with HttpError when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchWebProfileInfoUser(TEST_URL, 'include', {}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(HttpError);
      expect((result.left as HttpError).status).toBe(404);
    }
  });

  it('fails with NetworkError when fetch throws', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchWebProfileInfoUser(TEST_URL, 'include', {}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(NetworkError);
    }
  });

  it('fails with ResponseShapeUnknown when JSON shape is invalid', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { user: { id: { nested: 'bad' } } } }),
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(
      fetchWebProfileInfoUser(TEST_URL, 'include', {}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') {
      expect(result.left).toBeInstanceOf(ResponseShapeUnknown);
      expect((result.left as ResponseShapeUnknown).context).toBe('web_profile_info');
    }
  });
});

describe('fetchTopSearchUserId', () => {
  const topSearchResponse = (usernames: readonly string[]) => ({
    ok: true,
    status: 200,
    json: async () => ({
      users: usernames.map((username, index) => ({
        user: { username, pk: String(index + 1) },
      })),
    }),
  });

  it('picks the exact username from fuzzy results', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        topSearchResponse(['personabc', 'PersonA', 'persona'])
      ) as unknown as typeof fetch;

    const result = await Effect.runPromise(fetchTopSearchUserId('persona', {}));
    expect(result).toBe('2');
  });

  it('returns undefined when no result matches the username', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(topSearchResponse(['someoneelse'])) as unknown as typeof fetch;

    const result = await Effect.runPromise(fetchTopSearchUserId('persona', {}));
    expect(result).toBeUndefined();
  });

  it('fails with RateLimited on 429 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    }) as unknown as typeof fetch;

    const result = await Effect.runPromise(fetchTopSearchUserId('persona', {}).pipe(Effect.either));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(RateLimited);
  });
});
