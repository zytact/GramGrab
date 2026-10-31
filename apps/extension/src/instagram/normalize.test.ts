import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { normalizeInstantItems, normalizeReelsMediaItems } from './normalize.ts';
import { ReelsMediaResponseSchema } from '../effect/schemas.ts';
import storyFixture from '../effect/__fixtures__/story.json';

describe('normalizeReelsMediaItems', () => {
  const [reel] =
    Schema.decodeUnknownSync(ReelsMediaResponseSchema)(storyFixture).data
      .xdt_api__v1__feed__reels_media.reels_media;

  it('reads each Story by its media pk, original size, and expiry', () => {
    const [image, video] = normalizeReelsMediaItems([reel!], 'story');
    expect(image).toMatchObject({
      mediaId: 'SANITIZED_MEDIA_46_ID',
      type: 'image',
      url: 'https://sanitized.invalid/media/46/image',
      width: 963,
      height: 1712,
      filenameHint: 'SANITIZED_MEDIA_45_ID_SANITIZED_MEDIA_46_ID',
      expiresAt: new Date(1_793_535_900_000).toJSON(),
    });
    expect(video).toMatchObject({
      type: 'video',
      url: 'https://sanitized.invalid/media/47/video',
      previewUrl: 'https://sanitized.invalid/media/47/image',
    });
  });

  it('omits expiry on Highlights even when their Story payload has a timestamp', () => {
    expect(normalizeReelsMediaItems([reel!], 'highlight')[0]).not.toHaveProperty('expiresAt');
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
