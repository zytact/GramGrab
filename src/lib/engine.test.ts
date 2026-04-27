import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDownloadTasks, executeDownloadTasks } from './engine';

vi.mock('./resolver', () => ({
  resolveUsernameToId: vi.fn(),
}));

vi.mock('./graphql', () => ({
  fetchMediaByShortcode: vi.fn(),
  fetchReelsMedia: vi.fn(),
}));

import { resolveUsernameToId } from './resolver';
import { fetchMediaByShortcode, fetchReelsMedia } from './graphql';

describe('buildDownloadTasks', () => {
  it('returns empty array for invalid URL', async () => {
    const tasks = await buildDownloadTasks('https://google.com');
    expect(tasks).toEqual([]);
  });

  it('creates post task from post URL', async () => {
    const tasks = await buildDownloadTasks('https://www.instagram.com/p/abc123/');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('post');
    expect(tasks[0].shortcode).toBe('abc123');
  });

  it('creates reel task from reel URL', async () => {
    const tasks = await buildDownloadTasks('https://www.instagram.com/reel/abc123/');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('reel');
    expect(tasks[0].shortcode).toBe('abc123');
  });

  it('creates story task from story URL', async () => {
    const tasks = await buildDownloadTasks('https://www.instagram.com/stories/username/');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('story');
    expect(tasks[0].username).toBe('username');
  });

  it('creates highlight task from highlight URL', async () => {
    const tasks = await buildDownloadTasks('https://www.instagram.com/stories/highlights/abc123/');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('highlight');
    expect(tasks[0].highlightId).toBe('abc123');
  });

  it('extracts carousel index from post URL', async () => {
    const tasks = await buildDownloadTasks('https://www.instagram.com/p/abc123/?img_index=2');
    expect(tasks[0].carouselIndex).toBe(1);
  });

  it('does not include carousel index when not present', async () => {
    const tasks = await buildDownloadTasks('https://www.instagram.com/p/abc123/');
    expect(tasks[0].carouselIndex).toBeUndefined();
  });
});

describe('executeDownloadTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches post media for post task', async () => {
    const mockRawResponse = {
      data: {
        xdt_shortcode_media: {
          __typename: 'GraphImage',
          shortcode: 'abc123',
          display_url: 'https://instagram.com/img.jpg',
          id: '12345',
        },
      },
    };
    (fetchMediaByShortcode as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRawResponse);

    const tasks = [{ type: 'post' as const, shortcode: 'abc123' }];
    const result = await executeDownloadTasks(tasks);

    expect(fetchMediaByShortcode).toHaveBeenCalledWith('abc123');
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/img.jpg');
  });

  it('fetches media for reel task', async () => {
    const mockRawResponse = {
      data: {
        xdt_shortcode_media: {
          __typename: 'GraphVideo',
          shortcode: 'abc123',
          video_url: 'https://instagram.com/vid.mp4',
        },
      },
    };
    (fetchMediaByShortcode as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRawResponse);

    const tasks = [{ type: 'reel' as const, shortcode: 'abc123' }];
    const result = await executeDownloadTasks(tasks);

    expect(fetchMediaByShortcode).toHaveBeenCalledWith('abc123');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('video');
  });

  it('resolves username and fetches for story task', async () => {
    const mockRawResponse = {
      data: {
        reels_media: [
          {
            id: '123456',
            items: [
              {
                id: 'item1',
                display_url: 'https://instagram.com/img.jpg',
                is_video: false,
              },
            ],
          },
        ],
      },
    };
    (resolveUsernameToId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('123456');
    (fetchReelsMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRawResponse);

    const tasks = [{ type: 'story' as const, username: 'testuser' }];
    const result = await executeDownloadTasks(tasks);

    expect(resolveUsernameToId).toHaveBeenCalledWith('testuser');
    expect(fetchReelsMedia).toHaveBeenCalledWith({ reel_ids: ['123456'] });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/img.jpg');
  });

  it('throws when username resolution fails', async () => {
    (resolveUsernameToId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const tasks = [{ type: 'story' as const, username: 'testuser' }];

    await expect(executeDownloadTasks(tasks)).rejects.toThrow(
      'Could not resolve username: testuser'
    );
  });

  it('fetches highlight media for highlight task', async () => {
    const mockRawResponse = {
      data: {
        reels_media: [
          {
            id: 'highlight1',
            items: [
              {
                id: 'item1',
                display_url: 'https://instagram.com/img.jpg',
                is_video: false,
              },
            ],
          },
        ],
      },
    };
    (fetchReelsMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRawResponse);

    const tasks = [{ type: 'highlight' as const, highlightId: 'highlight1' }];
    const result = await executeDownloadTasks(tasks);

    expect(fetchReelsMedia).toHaveBeenCalledWith({ highlight_reel_ids: ['highlight1'] });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://instagram.com/img.jpg');
  });

  it('merges media from multiple tasks', async () => {
    const mockRawResponse1 = {
      data: {
        xdt_shortcode_media: {
          __typename: 'GraphImage',
          shortcode: 'post1',
          display_url: 'https://instagram.com/img1.jpg',
        },
      },
    };
    const mockRawResponse2 = {
      data: {
        xdt_shortcode_media: {
          __typename: 'GraphVideo',
          shortcode: 'reel1',
          video_url: 'https://instagram.com/vid.mp4',
        },
      },
    };
    (fetchMediaByShortcode as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockRawResponse1)
      .mockResolvedValueOnce(mockRawResponse2);

    const tasks = [
      { type: 'post' as const, shortcode: 'post1' },
      { type: 'reel' as const, shortcode: 'reel1' },
    ];
    const result = await executeDownloadTasks(tasks);

    expect(result).toHaveLength(2);
    expect(result[0].url).toBe('https://instagram.com/img1.jpg');
    expect(result[1].url).toBe('https://instagram.com/vid.mp4');
  });
});
