import { describe, it, expect } from 'vitest';
import { parseInstagramUrl } from './router';

describe('parseInstagramUrl', () => {
  describe('posts', () => {
    it('parses standard post URL', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/abc123/');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123' });
    });

    it('parses post URL without trailing slash', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/abc123');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123' });
    });

    it('parses post URL with query params', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/abc123/?utm_source=ig_web');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123' });
    });

    it('parses post URL with carousel index', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/abc123/?img_index=1');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123', carouselIndex: 0 });
    });

    it('parses post URL with carousel index 2', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/abc123/?img_index=3');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123', carouselIndex: 2 });
    });

    it('returns undefined for missing shortcode', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/');
      expect(result).toBeNull();
    });
  });

  describe('reels', () => {
    it('parses standard reel URL', () => {
      const result = parseInstagramUrl('https://www.instagram.com/reel/abc123/');
      expect(result).toEqual({ type: 'reel', shortcode: 'abc123' });
    });

    it('parses reel URL without trailing slash', () => {
      const result = parseInstagramUrl('https://www.instagram.com/reel/abc123');
      expect(result).toEqual({ type: 'reel', shortcode: 'abc123' });
    });

    it('returns undefined for missing shortcode', () => {
      const result = parseInstagramUrl('https://www.instagram.com/reel/');
      expect(result).toBeNull();
    });
  });

  describe('stories', () => {
    it('parses story URL', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/username/');
      expect(result).toEqual({ type: 'story', username: 'username' });
    });

    it('parses story URL without trailing slash', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/username');
      expect(result).toEqual({ type: 'story', username: 'username' });
    });

    it('returns undefined for missing username', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/');
      expect(result).toBeNull();
    });

    it('does not confuse stories with highlights', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/highlights/');
      expect(result).toBeNull();
    });
  });

  describe('highlights', () => {
    it('parses highlight URL', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/highlights/abc123/');
      expect(result).toEqual({ type: 'highlight', highlightId: 'abc123' });
    });

    it('parses highlight URL without trailing slash', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/highlights/abc123');
      expect(result).toEqual({ type: 'highlight', highlightId: 'abc123' });
    });

    it('returns undefined for missing highlight id', () => {
      const result = parseInstagramUrl('https://www.instagram.com/stories/highlights/');
      expect(result).toBeNull();
    });
  });

  describe('profiles', () => {
    it('parses profile URL', () => {
      const result = parseInstagramUrl('https://www.instagram.com/username/');
      expect(result).toEqual({ type: 'profile', username: 'username' });
    });

    it('parses profile URL without trailing slash', () => {
      const result = parseInstagramUrl('https://www.instagram.com/username');
      expect(result).toEqual({ type: 'profile', username: 'username' });
    });

    it('ignores reserved paths', () => {
      expect(parseInstagramUrl('https://www.instagram.com/reels/')).toBeNull();
      expect(parseInstagramUrl('https://www.instagram.com/explore/')).toBeNull();
    });
  });

  describe('rejection', () => {
    it('rejects non-Instagram domains', () => {
      expect(parseInstagramUrl('https://facebook.com/p/abc123/')).toBeNull();
      expect(parseInstagramUrl('https://google.com/')).toBeNull();
    });

    it('rejects non-matching hostname', () => {
      expect(parseInstagramUrl('https://www.instagram.com/')).toBeNull();
      expect(parseInstagramUrl('https://instagram.com/')).toBeNull();
    });

    it('rejects unsupported paths', () => {
      expect(parseInstagramUrl('https://www.instagram.com/explore/')).toBeNull();
      expect(parseInstagramUrl('https://www.instagram.com/direct/inbox/')).toBeNull();
    });

    it('returns null for invalid URLs', () => {
      expect(parseInstagramUrl('not-a-url')).toBeNull();
      expect(parseInstagramUrl('')).toBeNull();
    });
  });

  describe('alternative hostname', () => {
    it('accepts instagram.com without www', () => {
      const result = parseInstagramUrl('https://instagram.com/p/abc123/');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123' });
    });
  });

  describe('edge cases', () => {
    it('handles URL with extra path segments after shortcode', () => {
      const result = parseInstagramUrl('https://www.instagram.com/p/abc123/extra/');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123' });
    });

    it('finds shortcode in the middle of path', () => {
      const result = parseInstagramUrl('https://www.instagram.com/a/b/p/abc123/');
      expect(result).toEqual({ type: 'post', shortcode: 'abc123' });
    });
  });
});
