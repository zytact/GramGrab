import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { HttpError, NetworkError, RateLimited, ResponseShapeUnknown } from '../effect/errors.ts';
import fixture from '../effect/__fixtures__/shortcode-rest-video.json';
import {
  fetchRestShortcodeMedia,
  RestShortcodeResponseSchema,
  shortcodeMediaId,
} from './rest-shortcode.ts';

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('REST shortcode acquisition', () => {
  it('decodes the shortcode without losing precision and resolves captured video shape', async () => {
    expect(shortcodeMediaId('DdqbmumzPYZ')).toBe('3993125428256372249');
    expect(Schema.decodeUnknownSync(RestShortcodeResponseSchema)(fixture).items).toHaveLength(1);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ ...fixture, items: [{ ...fixture.items[0], code: 'DdqbmumzPYZ' }] })
        )
    );
    const items = await Effect.runPromise(fetchRestShortcodeMedia('DdqbmumzPYZ'));
    expect(items).toMatchObject([
      {
        type: 'video',
        mediaId: fixture.items[0]?.pk,
        width: fixture.items[0]?.video_versions[0]?.width,
        height: fixture.items[0]?.video_versions[0]?.height,
      },
    ]);
    expect(items[0]?.url).toMatch(/^https:\/\/sanitized\.invalid\//);
  });

  it('keeps sidecar child identities and media types', async () => {
    const child = fixture.items[0];
    const image = { ...child, pk: 'image-id', media_type: 1, video_versions: null };
    const sidecar = {
      ...child,
      media_type: 8,
      carousel_media: [
        { ...image, taken_at: undefined },
        { ...child, pk: 'video-id', taken_at: undefined },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(response({ status: 'ok', items: [{ ...sidecar, code: 'DdqbmumzPYZ' }] }))
    );
    const items = await Effect.runPromise(fetchRestShortcodeMedia('DdqbmumzPYZ'));
    expect(items.map(item => [item.type, item.mediaId])).toEqual([
      ['image', 'image-id'],
      ['video', 'video-id'],
    ]);
    expect(items.map(item => item.takenAt)).toEqual([child?.taken_at, child?.taken_at]);
  });

  it('fails when a known sidecar child lacks its required media versions', async () => {
    const child = fixture.items[0];
    const sidecar = {
      ...child,
      media_type: 8,
      carousel_media: [
        { ...child, pk: 'good-video' },
        { ...child, pk: 'broken-image', media_type: 1, image_versions2: null },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(response({ status: 'ok', items: [{ ...sidecar, code: 'DdqbmumzPYZ' }] }))
    );
    const result = await Effect.runPromise(
      fetchRestShortcodeMedia('DdqbmumzPYZ').pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(ResponseShapeUnknown);
  });

  it('passes through an unknown media type without treating it as a malformed known item', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          status: 'ok',
          items: [{ pk: 'unknown', code: 'DdqbmumzPYZ', media_type: 99 }],
        })
      )
    );
    expect(await Effect.runPromise(fetchRestShortcodeMedia('DdqbmumzPYZ'))).toEqual([]);
  });

  it('keeps a rejected body read as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new TypeError('body stream ended')),
      })
    );
    const result = await Effect.runPromise(
      fetchRestShortcodeMedia('DdqbmumzPYZ').pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(NetworkError);
  });

  it.each([401, 403, 429])('keeps HTTP %i as an actionable failure', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, status)));
    const result = await Effect.runPromise(
      fetchRestShortcodeMedia('DdqbmumzPYZ').pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left')
      expect(result.left).toBeInstanceOf(status === 429 ? RateLimited : HttpError);
  });

  it('reports a changed successful payload as a shape failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ status: 'ok', items: [{ pk: 'id' }] }))
    );
    const result = await Effect.runPromise(
      fetchRestShortcodeMedia('DdqbmumzPYZ').pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left).toBeInstanceOf(ResponseShapeUnknown);
  });
});
