import { Effect, Schema } from 'effect';
import { describe, it, expect } from 'vitest';
import { WebProfileInfoResponseSchema, WebProfileInfoUserSchema } from './schemas.ts';

describe('WebProfileInfoResponseSchema', () => {
  it('decodes a full valid response', async () => {
    const input = {
      data: {
        user: {
          id: '123456',
          pk: 123456,
          profile_pic_url_hd: 'https://example.com/hd.jpg',
          profile_pic_url: 'https://example.com/pic.jpg',
          profile_pic_dimensions: { width: 320, height: 320 },
          extra_unknown_field: 'ignored',
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)(input)
    );
    expect(result.data?.user?.id).toBe('123456');
    expect(result.data?.user?.profile_pic_url_hd).toBe('https://example.com/hd.jpg');
    expect(result.data?.user?.profile_pic_dimensions?.width).toBe(320);
  });

  it('decodes when data is absent', async () => {
    const result = await Effect.runPromise(Schema.decodeUnknown(WebProfileInfoResponseSchema)({}));
    expect(result.data).toBeUndefined();
  });

  it('decodes when user is absent inside data', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)({ data: {} })
    );
    expect(result.data?.user).toBeUndefined();
  });

  it('fails when id is not a string or number', async () => {
    const input = { data: { user: { id: { nested: 'object' } } } };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)(input).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });
});

describe('WebProfileInfoUserSchema', () => {
  it('ignores extra fields on decode', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoUserSchema)({
        id: '42',
        username: 'someone',
        biography: 'bio text',
      })
    );
    expect(result.id).toBe('42');
    expect((result as Record<string, unknown>)['username']).toBeUndefined();
  });
});
