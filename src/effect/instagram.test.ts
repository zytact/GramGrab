import { Effect } from 'effect';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchBlobAsDataUrl, fetchWebProfileInfoUser } from './instagram.ts';
import { HttpError, NetworkError, ResponseShapeUnknown } from './errors.ts';

beforeEach(() => {
  vi.restoreAllMocks();
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
