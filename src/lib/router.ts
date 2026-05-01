export type ContentType = 'post' | 'reel' | 'story' | 'highlight' | 'profile';

export interface ParsedUrl {
  type: ContentType;
  shortcode?: string;
  username?: string;
  highlightId?: string;
  carouselIndex?: number;
}

export function parseInstagramUrl(url: string): ParsedUrl | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.instagram.com' && u.hostname !== 'instagram.com') {
      return null;
    }

    const path = u.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (path.length === 0) return null;

    const postIndex = path.indexOf('p');
    if (postIndex >= 0 && path[postIndex + 1]) {
      return {
        type: 'post',
        shortcode: path[postIndex + 1],
        carouselIndex: u.searchParams.has('img_index')
          ? parseInt(u.searchParams.get('img_index')!) - 1
          : undefined,
      };
    }

    const reelIndex = path.indexOf('reel');
    if (reelIndex >= 0 && path[reelIndex + 1]) {
      return { type: 'reel', shortcode: path[reelIndex + 1] };
    }

    const storiesIndex = path.indexOf('stories');
    if (storiesIndex >= 0) {
      if (path[storiesIndex + 1] === 'highlights') {
        if (path[storiesIndex + 2]) {
          return { type: 'highlight', highlightId: path[storiesIndex + 2] };
        }
        return null;
      }
      if (path[storiesIndex + 1]) {
        return { type: 'story', username: path[storiesIndex + 1] };
      }
    }

    if (path.length === 1) {
      const username = path[0];
      const reserved = new Set([
        'p',
        'reel',
        'reels',
        'stories',
        'explore',
        'direct',
        'accounts',
        'tv',
      ]);
      if (!reserved.has(username)) {
        return { type: 'profile', username };
      }
    }

    return null;
  } catch {
    return null;
  }
}
