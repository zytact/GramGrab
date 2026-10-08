import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { normalizeInstantItems, normalizeReelsMediaItems } from './normalize.ts';
import { ReelsMediaResponseSchema } from '../effect/schemas.ts';

describe('Story expiry normalization', () => {
  function reels(expiresAt?: number, typename = 'GraphStoryImage') {
    return Schema.decodeUnknownSync(ReelsMediaResponseSchema)({
      data: {
        reels_media: [
          {
            id: '1',
            items: [
              {
                __typename: typename,
                id: '2',
                is_video: typename === 'GraphStoryVideo',
                display_url: 'https://sanitized.invalid/story.jpg',
                display_resources: [{ src: 'https://sanitized.invalid/story.jpg' }],
                video_resources: [{ src: 'https://sanitized.invalid/story.mp4' }],
                ...(expiresAt === undefined ? {} : { expiring_at_timestamp: expiresAt }),
              },
            ],
          },
        ],
      },
    }).data.reels_media;
  }

  it.each(['GraphStoryImage', 'GraphStoryVideo'])(
    'preserves %s expiry as UTC ISO 8601',
    typename => {
      expect(normalizeReelsMediaItems(reels(1_700_000_000, typename), 'story')[0]).toMatchObject({
        expiresAt: '2023-11-14T22:13:20.000Z',
      });
    }
  );

  it('omits expiry when Instagram does not provide it', () => {
    expect(normalizeReelsMediaItems(reels(), 'story')[0]).not.toHaveProperty('expiresAt');
  });

  it('omits expiry on Highlights even when their Story payload has a timestamp', () => {
    expect(normalizeReelsMediaItems(reels(1_700_000_000), 'highlight')[0]).not.toHaveProperty(
      'expiresAt'
    );
  });
});

describe('normalizeInstantItems', () => {
  it('keeps creator usernames from producing hidden download filenames', async () => {
    const media = await Effect.runPromise(
      normalizeInstantItems([
        {
          __typename: 'XDTMediaDict',
          id: '3976501635261214318_47173622955',
          taken_at: 1_788_256_237,
          source_type: 4,
          audience: 'besties',
          caption: null,
          user: {
            id: '47173622955',
            username: '._afrin_',
            full_name: 'A Friend',
            profile_pic_url: 'https://cdn.instagram.com/profile.jpg',
          },
          quick_snap_info: {},
          prompt_info: null,
          wearable_attribution_info: null,
          media_type: 1,
          image_versions2: {
            candidates: [
              { width: 1080, height: 1920, url: 'https://cdn.instagram.com/instant.jpg' },
            ],
          },
          video_versions: null,
          video_dash_manifest: null,
          video_duration: null,
        },
      ])
    );

    expect(media[0]?.filenameHint).toBe('afrin_instant_1788256237_3976501635261214318_47173622955');
  });
});
