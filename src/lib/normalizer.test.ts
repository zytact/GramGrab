import { describe, it, expect } from 'vitest';
import {
  normalizeShortcodeMedia,
  normalizeReelsMedia,
  normalizeProfilePicture,
} from './normalizer';

describe('normalizeShortcodeMedia', () => {
  it('returns empty array for null/undefined input', () => {
    expect(normalizeShortcodeMedia(null)).toEqual([]);
    expect(normalizeShortcodeMedia(undefined)).toEqual([]);
  });

  it('returns empty array when no media found', () => {
    expect(normalizeShortcodeMedia({})).toEqual([]);
    expect(normalizeShortcodeMedia({ data: {} })).toEqual([]);
  });

  describe('GraphImage', () => {
    it('extracts image from xdt_shortcode_media', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphImage',
            shortcode: 'abc123',
            display_url: 'https://instagram.com/image1.jpg',
            id: '12345',
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('image');
      expect(result[0].url).toBe('https://instagram.com/image1.jpg');
      expect(result[0].filenameHint).toBe('abc123_GraphImage');
    });

    it('uses uri as fallback for display_url', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphImage',
            shortcode: 'abc123',
            uri: 'https://instagram.com/image1.jpg',
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('https://instagram.com/image1.jpg');
    });
  });

  describe('GraphVideo', () => {
    it('extracts video_url as fallback when no video_resources', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphVideo',
            shortcode: 'abc123',
            video_url: 'https://instagram.com/video1.mp4',
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('video');
      expect(result[0].url).toBe('https://instagram.com/video1.mp4');
    });

    it('selects highest quality from video_resources', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphVideo',
            shortcode: 'abc123',
            video_resources: [
              { src: 'https://instagram.com/video720.mp4', config_width: 720 },
              { src: 'https://instagram.com/video1080.mp4', config_width: 1080 },
              { src: 'https://instagram.com/video480.mp4', config_width: 480 },
            ],
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('video');
      expect(result[0].url).toBe('https://instagram.com/video1080.mp4');
    });

    it('prefers video_resources over video_url', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphVideo',
            shortcode: 'abc123',
            video_url: 'https://instagram.com/video_low.mp4',
            video_resources: [{ src: 'https://instagram.com/video_high.mp4', config_width: 1080 }],
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result[0].url).toBe('https://instagram.com/video_high.mp4');
    });
  });

  describe('GraphSidecar (carousel)', () => {
    it('extracts all children from sidecar', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphSidecar',
            shortcode: 'abc123',
            edge_sidecar_to_children: {
              edges: [
                { node: { display_url: 'https://instagram.com/img1.jpg', is_video: false } },
                { node: { display_url: 'https://instagram.com/img2.jpg', is_video: false } },
              ],
            },
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('image');
      expect(result[1].type).toBe('image');
    });

    it('handles mixed video and image children', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphSidecar',
            shortcode: 'abc123',
            edge_sidecar_to_children: {
              edges: [
                { node: { display_url: 'https://instagram.com/img1.jpg', is_video: false } },
                { node: { video_url: 'https://instagram.com/vid1.mp4', is_video: true } },
              ],
            },
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('image');
      expect(result[1].type).toBe('video');
    });

    it('uses display_resources for child images', () => {
      const data = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphSidecar',
            shortcode: 'abc123',
            edge_sidecar_to_children: {
              edges: [
                {
                  node: {
                    display_resources: [
                      { src: 'https://instagram.com/img_small.jpg', config_width: 320 },
                      { src: 'https://instagram.com/img_large.jpg', config_width: 1080 },
                    ],
                    is_video: false,
                  },
                },
              ],
            },
          },
        },
      };
      const result = normalizeShortcodeMedia(data);
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('https://instagram.com/img_large.jpg');
    });
  });

  it('extracts taken_at_timestamp when present', () => {
    const data = {
      data: {
        xdt_shortcode_media: {
          __typename: 'GraphImage',
          shortcode: 'abc123',
          display_url: 'https://instagram.com/image.jpg',
          taken_at_timestamp: 1700000000,
        },
      },
    };
    const result = normalizeShortcodeMedia(data);
    expect(result[0].takenAt).toBe(1700000000);
  });

  it('extracts dimensions when present', () => {
    const data = {
      data: {
        xdt_shortcode_media: {
          __typename: 'GraphImage',
          shortcode: 'abc123',
          display_url: 'https://instagram.com/image.jpg',
          dimensions: { width: 1080, height: 1350 },
        },
      },
    };
    const result = normalizeShortcodeMedia(data);
    expect(result[0].width).toBe(1080);
    expect(result[0].height).toBe(1350);
  });

  it('falls back to shortcode_media path', () => {
    const data = {
      data: {
        shortcode_media: {
          __typename: 'GraphImage',
          shortcode: 'abc123',
          display_url: 'https://instagram.com/image.jpg',
        },
      },
    };
    const result = normalizeShortcodeMedia(data);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/image.jpg');
  });

  it('handles data without data wrapper', () => {
    const data = {
      xdt_shortcode_media: {
        __typename: 'GraphImage',
        shortcode: 'abc123',
        display_url: 'https://instagram.com/image.jpg',
      },
    };
    const result = normalizeShortcodeMedia(data);
    expect(result).toHaveLength(1);
  });
});

describe('normalizeReelsMedia', () => {
  it('returns empty array for null/undefined input', () => {
    expect(normalizeReelsMedia(null)).toEqual([]);
    expect(normalizeReelsMedia(undefined)).toEqual([]);
  });

  it('returns empty array when no reels found', () => {
    expect(normalizeReelsMedia({})).toEqual([]);
    expect(normalizeReelsMedia({ data: {} })).toEqual([]);
  });

  it('extracts image items from reels_media', () => {
    const data = {
      data: {
        reels_media: [
          {
            id: 'reel123',
            items: [
              {
                id: 'item1',
                display_url: 'https://instagram.com/img1.jpg',
                is_video: false,
                taken_at_timestamp: 1700000000,
              },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image');
    expect(result[0].url).toBe('https://instagram.com/img1.jpg');
    expect(result[0].filenameHint).toBe('reel123_item1');
    expect(result[0].takenAt).toBe(1700000000);
  });

  it('extracts video items from reels_media', () => {
    const data = {
      data: {
        reels_media: [
          {
            id: 'reel123',
            items: [
              {
                id: 'item1',
                video_url: 'https://instagram.com/video1.mp4',
                is_video: true,
              },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('video');
    expect(result[0].url).toBe('https://instagram.com/video1.mp4');
  });

  it('selects highest quality from video_resources', () => {
    const data = {
      data: {
        reels_media: [
          {
            id: 'reel123',
            items: [
              {
                id: 'item1',
                video_resources: [
                  { src: 'https://instagram.com/vid720.mp4', config_width: 720 },
                  { src: 'https://instagram.com/vid1080.mp4', config_width: 1080 },
                ],
                is_video: true,
              },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result[0].url).toBe('https://instagram.com/vid1080.mp4');
  });

  it('extracts dimensions from items', () => {
    const data = {
      data: {
        reels_media: [
          {
            id: 'reel123',
            items: [
              {
                id: 'item1',
                display_url: 'https://instagram.com/img1.jpg',
                is_video: false,
                dimensions: { width: 1080, height: 1920 },
              },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result[0].width).toBe(1080);
    expect(result[0].height).toBe(1920);
  });

  it('handles multiple reels and items', () => {
    const data = {
      data: {
        reels_media: [
          {
            id: 'reel1',
            items: [
              { id: 'item1', display_url: 'https://instagram.com/img1.jpg', is_video: false },
              { id: 'item2', display_url: 'https://instagram.com/img2.jpg', is_video: false },
            ],
          },
          {
            id: 'reel2',
            items: [
              { id: 'item3', display_url: 'https://instagram.com/img3.jpg', is_video: false },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.filenameHint)).toEqual(['reel1_item1', 'reel1_item2', 'reel2_item3']);
  });

  it('falls back to uri for display_url', () => {
    const data = {
      data: {
        reels_media: [
          {
            id: 'reel123',
            items: [
              {
                id: 'item1',
                uri: 'https://instagram.com/img1.jpg',
                is_video: false,
              },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result[0].url).toBe('https://instagram.com/img1.jpg');
  });

  it('handles data without data wrapper', () => {
    const data = {
      reels_media: [
        {
          id: 'reel123',
          items: [
            {
              id: 'item1',
              display_url: 'https://instagram.com/img1.jpg',
              is_video: false,
            },
          ],
        },
      ],
    };
    const result = normalizeReelsMedia(data);
    expect(result).toHaveLength(1);
  });

  it('handles reels alias path', () => {
    const data = {
      data: {
        reels: [
          {
            id: 'reel123',
            items: [
              {
                id: 'item1',
                display_url: 'https://instagram.com/img1.jpg',
                is_video: false,
              },
            ],
          },
        ],
      },
    };
    const result = normalizeReelsMedia(data);
    expect(result).toHaveLength(1);
  });
});

describe('normalizeProfilePicture', () => {
  it('extracts profile_pic_url_hd when present', () => {
    const data = {
      data: {
        user: {
          profile_pic_url_hd: 'https://instagram.com/s320x320/profile_hd.jpg',
          profile_pic_url: 'https://instagram.com/profile.jpg',
          profile_pic_dimensions: { width: 320, height: 320 },
        },
      },
    };
    const result = normalizeProfilePicture(data, 'testuser');
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/s1080x1080/profile_hd.jpg');
    expect(result[0].width).toBe(320);
    expect(result[0].filenameHint).toBe('testuser_profile');
  });

  it('falls back to profile_pic_url', () => {
    const data = {
      data: {
        user: {
          profile_pic_url: 'https://instagram.com/s150x150/profile.jpg',
        },
      },
    };
    const result = normalizeProfilePicture(data, 'testuser');
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/s1080x1080/profile.jpg');
  });

  it('falls back to provided fallbackUrl', () => {
    const result = normalizeProfilePicture(
      {},
      'testuser',
      'https://instagram.com/s150x150/fallback.jpg'
    );
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/s1080x1080/fallback.jpg');
  });

  it('returns empty array when no url available', () => {
    const result = normalizeProfilePicture({}, 'testuser');
    expect(result).toEqual([]);
  });
});
