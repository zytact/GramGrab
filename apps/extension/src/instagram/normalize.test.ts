import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { normalizeInstantItems } from './normalize.ts';

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
