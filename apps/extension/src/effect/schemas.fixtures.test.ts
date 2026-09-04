/**
 * Fixture-based schema tests.
 *
 * Each test decodes a real Instagram API response captured by
 * scripts/capture-ig-fixtures.mjs. They verify that our schemas can parse
 * the actual shapes IG serves today. If any test fails after a schema change,
 * it means the real API shape diverged — see src/effect/__fixtures__/README.md
 * for the refresh workflow.
 */
import { Effect, Schema } from 'effect';
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  HdAvatarResponseSchema,
  HighlightsTrayResponseSchema,
  InstantPhotoSchema,
  InstantVideoSchema,
  InstantsFeedResponseSchema,
  ReelsMediaResponseSchema,
  ShortcodeMediaResponseSchema,
  TopSearchResponseSchema,
  WebProfileInfoResponseSchema,
} from './schemas.ts';
import type {
  ShortcodeImage,
  ShortcodeSidecar,
  ShortcodeVideo,
  StoryVideoItem,
} from './schemas.ts';

function loadFixture(name: string): unknown {
  const raw = readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf-8');
  return JSON.parse(raw);
}

describe('fixtures: highlights.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('highlights.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(json));
    expect(result.data.reels_media.length).toBeGreaterThan(0);
  });

  it('first reel has __typename GraphHighlightReel', async () => {
    const json = loadFixture('highlights.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(json));
    expect(result.data.reels_media[0]?.__typename).toBe('GraphHighlightReel');
  });

  it('first reel has items with video_resources', async () => {
    const json = loadFixture('highlights.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(json));
    const firstItem = result.data.reels_media[0]?.items[0];
    expect(firstItem?.__typename).toBe('GraphStoryVideo');
    if (firstItem?.__typename !== 'GraphStoryVideo') return;
    const video = firstItem as StoryVideoItem;
    expect(video.video_resources.length).toBeGreaterThan(0);
    expect(typeof video.video_resources[0]?.src).toBe('string');
    expect(typeof video.display_url).toBe('string');
  });
});

describe('fixtures: active Instants', () => {
  it.each([
    'instants-photo.json',
    'instants-video.json',
    'instants-empty.json',
    'instants-unknown.json',
  ])('decodes %s', async name => {
    await expect(
      Effect.runPromise(Schema.decodeUnknown(InstantsFeedResponseSchema)(loadFixture(name)))
    ).resolves.toBeDefined();
  });

  it('rejects a changed known typename shape', async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(InstantsFeedResponseSchema)(loadFixture('instants-invalid-known.json'))
      )
    ).rejects.toBeDefined();
  });

  it('keeps ordered items and sample items separate', async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(InstantsFeedResponseSchema)(loadFixture('instants-photo.json'))
    );
    expect(decoded.data.xdt_get_quick_snaps.items_ordered_by_time).toHaveLength(3);
    expect(decoded.data.xdt_get_quick_snaps.sample_items).toEqual([]);
  });

  it('decodes live caption, prompt, and filter metadata', async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(InstantsFeedResponseSchema)(loadFixture('instants-photo.json'))
    );
    const item = decoded.data.xdt_get_quick_snaps.items_ordered_by_time[1];
    expect(item?.__typename).toBe('XDTMediaDict');
    if (!Schema.is(InstantPhotoSchema)(item)) return;
    expect(item.caption?.__typename).toBe('XDTCommentDict');
    expect(typeof item.caption?.text).toBe('string');
    expect(typeof item.prompt_info?.id).toBe('string');
    expect(typeof item.prompt_info?.text).toBe('string');
    expect(typeof item.quick_snap_info.filter_key).toBe('string');
  });

  it('decodes live progressive video version identifiers', async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknown(InstantsFeedResponseSchema)(loadFixture('instants-video.json'))
    );
    const item = decoded.data.xdt_get_quick_snaps.items_ordered_by_time[0];
    expect(item?.__typename).toBe('XDTMediaDict');
    if (!Schema.is(InstantVideoSchema)(item) || !item.video_versions) return;
    expect(typeof item.video_versions[0]?.id).toBe('string');
  });
});

describe('fixtures: story.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('story.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(json));
    expect(result.data.reels_media.length).toBeGreaterThan(0);
  });

  it('first reel has __typename GraphReel', async () => {
    const json = loadFixture('story.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(json));
    expect(result.data.reels_media[0]?.__typename).toBe('GraphReel');
  });

  it('items have required display_url and video_resources', async () => {
    const json = loadFixture('story.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(ReelsMediaResponseSchema)(json));
    const items = result.data.reels_media[0]?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (item.__typename !== 'GraphStoryVideo') continue;
      const video = item as StoryVideoItem;
      expect(typeof video.display_url).toBe('string');
      expect(video.video_resources.length).toBeGreaterThan(0);
    }
  });
});

describe('fixtures: avatar.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('avatar.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(HdAvatarResponseSchema)(json));
    expect(result.user).toBeDefined();
  });

  it('accepts current empty-user response from the HD avatar endpoint', async () => {
    const json = loadFixture('avatar.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(HdAvatarResponseSchema)(json));
    expect(result.user.hd_profile_pic_url_info).toBeUndefined();
    expect(result.user.hd_profile_pic_versions).toBeUndefined();
  });

  it('falls back to web_profile_info for usable avatar URL coverage', async () => {
    const json = loadFixture('avatar.json');
    await Effect.runPromise(Schema.decodeUnknown(HdAvatarResponseSchema)(json));

    const profileJson = loadFixture('web-profile-info.json');
    const profile = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)(profileJson)
    );
    expect(typeof profile.data?.user?.profile_pic_url_hd).toBe('string');
  });

  it('response has no data wrapper (top-level user key)', async () => {
    // Confirms the bug fix: old code read data?.user, real shape is just user
    const json = loadFixture('avatar.json') as Record<string, unknown>;
    expect('user' in json).toBe(true);
    expect('data' in json).toBe(false);
  });
});

describe('fixtures: web-profile-info.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('web-profile-info.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)(json)
    );
    expect(result.data?.user).toBeDefined();
  });

  it('exposes a user id (used to bridge username → reels/avatar fetches)', async () => {
    const json = loadFixture('web-profile-info.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(WebProfileInfoResponseSchema)(json)
    );
    const id = result.data?.user?.id;
    expect(id).toBeDefined();
    expect(typeof id === 'string' || typeof id === 'number').toBe(true);
  });
});

describe('fixtures: topsearch.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('topsearch.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(TopSearchResponseSchema)(json));
    expect(result.users?.length).toBeGreaterThan(0);
  });

  it('exposes a username and id for the exact-match lookup', async () => {
    const json = loadFixture('topsearch.json');
    const result = await Effect.runPromise(Schema.decodeUnknown(TopSearchResponseSchema)(json));
    const user = result.users?.[0]?.user;
    expect(typeof user?.username).toBe('string');
    const id = user?.pk ?? user?.pk_id;
    expect(typeof id === 'string' || typeof id === 'number').toBe(true);
  });
});

describe('fixtures: highlights-tray.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('highlights-tray.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)(json)
    );
    expect(result.tray.length).toBeGreaterThan(0);
  });

  it('first tray item has an id and cover_media', async () => {
    const json = loadFixture('highlights-tray.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(HighlightsTrayResponseSchema)(json)
    );
    const first = result.tray[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(typeof first.id === 'string' || typeof first.id === 'number').toBe(true);
    expect(first.cover_media).toBeDefined();
  });
});

describe('fixtures: shortcode-image.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('shortcode-image.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(json)
    );
    expect(result.data?.xdt_shortcode_media ?? result.data?.shortcode_media).toBeDefined();
  });

  it('node is an image __typename with display_resources', async () => {
    const json = loadFixture('shortcode-image.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(json)
    );
    const node = result.data?.xdt_shortcode_media ?? result.data?.shortcode_media;
    expect(node?.__typename).toMatch(/Image/);
    const image = node as ShortcodeImage;
    expect((image.display_resources ?? []).length).toBeGreaterThan(0);
  });
});

describe('fixtures: shortcode-video.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('shortcode-video.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(json)
    );
    expect(result.data?.xdt_shortcode_media ?? result.data?.shortcode_media).toBeDefined();
  });

  it('node is a video __typename with a playable URL (video_resources or video_url)', async () => {
    const json = loadFixture('shortcode-video.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(json)
    );
    const node = result.data?.xdt_shortcode_media ?? result.data?.shortcode_media;
    expect(node?.__typename).toMatch(/Video|ClipsShareVideo/);
    const video = node as ShortcodeVideo;
    const hasResources = (video.video_resources ?? []).length > 0;
    const hasUrl = typeof video.video_url === 'string' && video.video_url.length > 0;
    expect(hasResources || hasUrl).toBe(true);
  });
});

describe('fixtures: shortcode-sidecar.json', () => {
  it('decodes successfully', async () => {
    const json = loadFixture('shortcode-sidecar.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(json)
    );
    expect(result.data?.xdt_shortcode_media ?? result.data?.shortcode_media).toBeDefined();
  });

  it('node is a sidecar with children, at least one of which is a video', async () => {
    const json = loadFixture('shortcode-sidecar.json');
    const result = await Effect.runPromise(
      Schema.decodeUnknown(ShortcodeMediaResponseSchema)(json)
    );
    const node = result.data?.xdt_shortcode_media ?? result.data?.shortcode_media;
    expect(node?.__typename).toMatch(/Sidecar|Album/);
    const sidecar = node as ShortcodeSidecar;
    const edges = sidecar.edge_sidecar_to_children?.edges ?? [];
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.some(e => e.node.is_video === true)).toBe(true);
  });
});
