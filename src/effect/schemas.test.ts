import { Effect, Schema } from 'effect';
import { describe, it, expect } from 'vitest';
import {
  ShortcodeMediaResponseSchema,
  WebProfileInfoResponseSchema,
  WebProfileInfoUserSchema,
} from './schemas.ts';

describe('ShortcodeMediaResponseSchema', () => {
  it('decodes a data-wrapped XDTGraphImage response', async () => {
    const input = {
      data: {
        xdt_shortcode_media: {
          __typename: 'XDTGraphImage',
          shortcode: 'abc123',
          display_url: 'https://cdn.instagram.com/image.jpg',
          taken_at_timestamp: 1700000000,
          extra_field: 'ignored',
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input)
    );
    expect(result.data?.xdt_shortcode_media?.__typename).toBe('XDTGraphImage');
    expect(result.data?.xdt_shortcode_media?.display_url).toBe(
      'https://cdn.instagram.com/image.jpg'
    );
    expect(result.data?.xdt_shortcode_media?.taken_at_timestamp).toBe(1700000000);
    expect(
      (result.data?.xdt_shortcode_media as Record<string, unknown>)?.['extra_field']
    ).toBeUndefined();
  });

  it('decodes top-level aliases without data wrapper', async () => {
    const input = {
      shortcode_media: {
        __typename: 'GraphVideo',
        shortcode: 'xyz',
        video_url: 'https://cdn.instagram.com/video.mp4',
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input)
    );
    expect(result.shortcode_media?.__typename).toBe('GraphVideo');
    expect(result.shortcode_media?.video_url).toBe('https://cdn.instagram.com/video.mp4');
  });

  it('decodes a sidecar with edge children', async () => {
    const input = {
      data: {
        xdt_shortcode_media: {
          __typename: 'XDTGraphSidecar',
          shortcode: 'sidecar1',
          edge_sidecar_to_children: {
            edges: [
              {
                node: {
                  __typename: 'XDTGraphImage',
                  display_url: 'https://cdn.instagram.com/slide1.jpg',
                  display_resources: [
                    { src: 'https://cdn.instagram.com/1080.jpg', config_width: 1080 },
                  ],
                },
              },
            ],
          },
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input)
    );
    const child = result.data?.xdt_shortcode_media?.edge_sidecar_to_children?.edges?.[0]?.node;
    expect(child?.display_url).toBe('https://cdn.instagram.com/slide1.jpg');
    expect(child?.display_resources?.[0]?.config_width).toBe(1080);
  });

  it('fails when a display_resource src is missing', async () => {
    const input = {
      data: {
        xdt_shortcode_media: {
          display_resources: [{ config_width: 1080 }], // src is required
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });
});

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
