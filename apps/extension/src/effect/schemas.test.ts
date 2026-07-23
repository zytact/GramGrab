import { Effect, Schema } from 'effect';
import { describe, it, expect } from 'vite-plus/test';
import {
  HighlightsTrayResponseSchema,
  ReelsMediaResponseSchema,
  ShortcodeMediaResponseSchema,
  WebProfileInfoResponseSchema,
  WebProfileInfoUserSchema,
} from './schemas.ts';

// ---------------------------------------------------------------------------
// ShortcodeMediaResponseSchema — edge cases not covered by real fixtures
// ---------------------------------------------------------------------------

describe('ShortcodeMediaResponseSchema', () => {
  it('fails when a display_resource src is missing on a known typename', async () => {
    // MediaResourceSchema.src is required. When __typename is a known image literal,
    // the Image variant is tried first and fails on the missing src.
    // The union then tries Sidecar (wrong typename), then Unknown (succeeds — no src check).
    // Net result: decode succeeds via Unknown passthrough; normalizer warns + skips.
    // This test documents B2 behavior: the response is not rejected at schema level.
    const input = {
      data: {
        xdt_shortcode_media: {
          __typename: 'XDTGraphImage',
          display_resources: [{ config_width: 1080 }], // src absent
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input).pipe(Effect.either)
    );
    // Succeeds via Unknown passthrough (B2 design decision)
    expect(result._tag).toBe('Right');
  });

  it('succeeds with an unknown __typename (Unknown passthrough)', async () => {
    // Verifies that a new IG typename does not reject the response
    const input = {
      data: {
        xdt_shortcode_media: {
          __typename: 'XDTGraphCarouselV2', // hypothetical new type
          id: '123',
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input)
    );
    expect(result.data?.xdt_shortcode_media?.__typename).toBe('XDTGraphCarouselV2');
  });

  it('succeeds when data wrapper is absent (top-level aliases)', async () => {
    // IG occasionally returns top-level keys instead of wrapping in data
    const input = {
      shortcode_media: {
        __typename: 'GraphVideo',
        id: '42',
        video_resources: [{ src: 'https://cdn.instagram.com/video.mp4', config_width: 720 }],
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input)
    );
    expect(result.shortcode_media?.__typename).toBe('GraphVideo');
  });

  it('fails when a video node is missing video_resources (required on video variant)', async () => {
    const input = {
      data: {
        xdt_shortcode_media: {
          __typename: 'XDTGraphVideo',
          id: '99',
          // video_resources absent — required on ShortcodeVideoSchema
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input).pipe(Effect.either)
    );
    // Falls through to UnknownSchema and succeeds — __typename presence determines union branch.
    // Unknown passthrough accepts it. The normalizer will warn and skip.
    expect(result._tag).toBe('Right');
  });

  it('decodes a sidecar edge child without a src (normalizer skips, schema passes)', async () => {
    // SidecarChildNodeSchema.display_resources items require src.
    // A missing src inside a sidecar child causes the sidecar decode to fail,
    // and the union falls through to Unknown passthrough (B2). The response succeeds;
    // the normalizer will produce no MediaItem for that child.
    const input = {
      data: {
        xdt_shortcode_media: {
          __typename: 'XDTGraphSidecar',
          edge_sidecar_to_children: {
            edges: [
              {
                node: {
                  display_resources: [{ config_width: 640 }], // no src
                },
              },
            ],
          },
        },
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(input).pipe(Effect.either)
    );
    // Succeeds via Unknown passthrough (B2 design decision)
    expect(result._tag).toBe('Right');
  });
});

// ---------------------------------------------------------------------------
// WebProfileInfoResponseSchema — edge cases
// ---------------------------------------------------------------------------

describe('WebProfileInfoResponseSchema', () => {
  it('decodes when data wrapper is absent', async () => {
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
    // id union is String | Number — objects must fail
    const input = { data: { user: { id: { nested: 'object' } } } };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)(input).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });

  it('ignores extra fields on the user object', async () => {
    // Schema.Struct is open — unknown fields are stripped, not rejected
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoUserSchema)({
        id: '42',
        username: 'someone',
        biography: 'bio',
      })
    );
    expect(result.id).toBe('42');
    expect((result as Record<string, unknown>)['username']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HighlightsTrayResponseSchema — edge cases
// ---------------------------------------------------------------------------

describe('HighlightsTrayResponseSchema', () => {
  it('decodes an empty tray', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)({ tray: [] })
    );
    expect(result.tray).toEqual([]);
  });

  it('decodes when full_image_version is null (IG returns explicit null)', async () => {
    // cover_media.full_image_version is NullOr — null must be preserved, not treated as absent
    const input = {
      tray: [
        {
          id: 'highlight:1',
          title: 'X',
          cover_media: {
            full_image_version: null,
            cropped_image_version: { url: 'https://cdn.instagram.com/c.jpg' },
          },
        },
      ],
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)(input)
    );
    expect(result.tray[0]?.cover_media.full_image_version).toBeNull();
  });

  it('fails when cover_media is missing (required field)', async () => {
    const input = { tray: [{ id: '1', title: 'X' }] };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)(input).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });

  it('fails when tray is absent (required field)', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)({}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });
});

// ---------------------------------------------------------------------------
// ReelsMediaResponseSchema — edge cases
// ---------------------------------------------------------------------------

describe('ReelsMediaResponseSchema', () => {
  it('decodes an empty reels_media array', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ReelsMediaResponseSchema)({ data: { reels_media: [] } })
    );
    expect(result.data.reels_media).toEqual([]);
  });

  it('fails when data wrapper is absent (required field)', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ReelsMediaResponseSchema)({}).pipe(Effect.either)
    );
    expect(result._tag).toBe('Left');
  });

  it('succeeds with unknown story item __typename (Unknown passthrough)', async () => {
    // A new IG story type must not reject the whole reel
    const input = {
      data: {
        reels_media: [
          {
            id: '123',
            items: [{ __typename: 'GraphStoryCarouselV2', id: 'abc' }],
          },
        ],
      },
    };
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(input));
    expect(result.data.reels_media[0]?.items[0]?.__typename).toBe('GraphStoryCarouselV2');
  });

  it('fails when a story video is missing video_resources (required on video variant)', async () => {
    // GraphStoryVideo requires video_resources — decode falls through to Unknown, succeeds
    // (the normalizer skips it; schema does not reject it)
    const input = {
      data: {
        reels_media: [
          {
            id: '123',
            items: [
              {
                __typename: 'GraphStoryVideo',
                id: 'abc',
                is_video: true,
                display_url: 'https://cdn.instagram.com/img.jpg',
                display_resources: [],
                // video_resources absent
              },
            ],
          },
        ],
      },
    };
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ReelsMediaResponseSchema)(input).pipe(Effect.either)
    );
    // Falls to Unknown passthrough — response succeeds, normalizer warns + skips
    expect(result._tag).toBe('Right');
  });
});
