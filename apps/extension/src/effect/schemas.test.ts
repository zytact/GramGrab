import { Effect, Schema } from 'effect';
import { describe, it, expect } from 'vite-plus/test';
import {
  HighlightsTrayResponseSchema,
  ReelsMediaResponseSchema,
  ShortcodeMediaResponseSchema,
} from './schemas.ts';

// ---------------------------------------------------------------------------
// ShortcodeMediaResponseSchema edge cases not covered by real fixtures
// ---------------------------------------------------------------------------

describe('ShortcodeMediaResponseSchema', () => {
  it.each([
    ['an unknown __typename', { __typename: 'XDTGraphCarouselV2', id: '123' }],
    [
      'a known image without a display_resource src',
      { __typename: 'XDTGraphImage', display_resources: [{ config_width: 1080 }] },
    ],
    ['a known video without video_resources', { __typename: 'XDTGraphVideo', id: '99' }],
    [
      'a sidecar child without a display_resource src',
      {
        __typename: 'XDTGraphSidecar',
        edge_sidecar_to_children: {
          edges: [{ node: { display_resources: [{ config_width: 640 }] } }],
        },
      },
    ],
  ])('decodes %s through the Unknown passthrough', async (_, media) => {
    // A new or malformed node must not reject the response. The normalizer warns and skips it.
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)({ data: { xdt_shortcode_media: media } })
    );
    expect(result.data?.xdt_shortcode_media?.__typename).toBe(media.__typename);
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
});

// ---------------------------------------------------------------------------
// HighlightsTrayResponseSchema edge cases
// ---------------------------------------------------------------------------

describe('HighlightsTrayResponseSchema', () => {
  it('decodes an empty tray', async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)({ tray: [] })
    );
    expect(result.tray).toEqual([]);
  });

  it('decodes when full_image_version is null (IG returns explicit null)', async () => {
    // cover_media.full_image_version is NullOr. Null must be preserved, not treated as absent
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
// ReelsMediaResponseSchema edge cases
// ---------------------------------------------------------------------------

describe('ReelsMediaResponseSchema', () => {
  const response = (items: readonly unknown[]) => ({
    data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: '123', items }] } },
  });
  const decode = (input: unknown) =>
    Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(input).pipe(Effect.either));

  it('fails when data wrapper is absent (required field)', async () => {
    expect((await decode({}))._tag).toBe('Left');
  });

  it('succeeds with unknown story item __typename (Unknown passthrough)', async () => {
    const result = await decode(response([{ __typename: 'XDTStoryCarouselV2' }]));
    expect(result._tag).toBe('Right');
  });

  it('fails when a known story video is missing video_versions', async () => {
    const video = {
      __typename: 'XDTMediaDict',
      pk: '1',
      media_type: 2,
      taken_at: 1,
      expiring_at: 2,
      original_width: 720,
      original_height: 1280,
      image_versions2: { candidates: [] },
      video_versions: null,
    };
    expect((await decode(response([video])))._tag).toBe('Left');
  });
});
