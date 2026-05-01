import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchMediaByShortcode, fetchReelsMedia, fetchProfileInfo } from './graphql';

global.fetch = vi.fn();

describe('graphql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchMediaByShortcode', () => {
    it('fetches media by shortcode', async () => {
      const mockData = {
        data: {
          xdt_shortcode_media: {
            __typename: 'GraphImage',
            shortcode: 'abc123',
            display_url: 'https://instagram.com/img.jpg',
          },
        },
      };
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const result = await fetchMediaByShortcode('abc123');
      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('throws on non-ok response', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(fetchMediaByShortcode('abc123')).rejects.toThrow(
        'GraphQL request failed: 500 Internal Server Error'
      );
    });

    it('sends correct query parameters', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchMediaByShortcode('testshortcode');

      const [url] = fetch.mock.calls[0];
      expect(url).toContain('doc_id=');
      expect(url).toContain('variables=');
      expect(url).toContain('testshortcode');
    });
  });

  describe('fetchReelsMedia', () => {
    it('fetches reels media with reel_ids', async () => {
      const mockData = {
        data: {
          reels_media: [],
        },
      };
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const result = await fetchReelsMedia({ reel_ids: ['123456'] });
      expect(result).toEqual(mockData);
    });

    it('fetches reels media with highlight_reel_ids', async () => {
      const mockData = {
        data: {
          reels_media: [],
        },
      };
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const result = await fetchReelsMedia({ highlight_reel_ids: ['highlight123'] });
      expect(result).toEqual(mockData);
    });

    it('sends correct query parameters with query_hash', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchReelsMedia({ reel_ids: ['123'] });

      const [url] = fetch.mock.calls[0];
      expect(url).toContain('query_hash=');
      expect(url).toContain('reel_ids');
      expect(url).toContain('highlight_reel_ids');
    });

    it('throws on non-ok response', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(fetchReelsMedia({ reel_ids: ['123'] })).rejects.toThrow(
        'GraphQL request failed: 429 Too Many Requests'
      );
    });

    it('sends empty arrays for missing parameters', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await fetchReelsMedia({});

      const [url] = fetch.mock.calls[0];
      expect(url).toContain('variables=');
      const varsStart = url.indexOf('variables=') + 10;
      const varsJson = decodeURIComponent(url.slice(varsStart));
      const vars = JSON.parse(varsJson);
      expect(vars.reel_ids).toEqual([]);
      expect(vars.highlight_reel_ids).toEqual([]);
    });
  });

  describe('fetchProfileInfo', () => {
    it('fetches profile info without credentials', async () => {
      const mockData = { data: { user: { username: 'testuser' } } };
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const result = await fetchProfileInfo('testuser');
      expect(result).toEqual(mockData);

      const [url, options] = fetch.mock.calls[0];
      expect(url).toContain('web_profile_info');
      expect(url).toContain('username=testuser');
      expect(options.credentials).toBe('omit');
    });

    it('throws on non-ok response', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(fetchProfileInfo('testuser')).rejects.toThrow(
        'Profile request failed: 404 Not Found'
      );
    });
  });

  it('includes credentials and correct headers', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await fetchMediaByShortcode('abc123');

    const [, options] = fetch.mock.calls[0];
    expect(options.credentials).toBe('include');
    expect(options.headers).toBeDefined();
    expect(options.headers['Origin']).toBe('https://www.instagram.com');
  });
});
