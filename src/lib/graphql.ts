import { OPERATIONS, IG_HEADERS, ENDPOINTS } from './config';
import type { MediaItem } from './normalizer';

export async function fetchMediaByShortcode(shortcode: string): Promise<MediaItem[]> {
  const variables = { shortcode };
  return fetchGraphQL(OPERATIONS.MEDIA_BY_SHORTCODE.doc_id, 'doc_id', variables);
}

export async function fetchReelsMedia(params: {
  reel_ids?: string[];
  highlight_reel_ids?: string[];
}): Promise<MediaItem[]> {
  const variables = {
    reel_ids: params.reel_ids ?? [],
    highlight_reel_ids: params.highlight_reel_ids ?? [],
    location_ids: [],
    precomposed_overlay: false,
  };
  return fetchGraphQL(OPERATIONS.REELS_MEDIA.query_hash, 'query_hash', variables);
}

export async function fetchProfileInfo(username: string): Promise<Record<string, unknown>> {
  const url = `${ENDPOINTS.userProfile}?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    credentials: 'omit',
    headers: {
      ...IG_HEADERS,
      Origin: 'https://www.instagram.com',
    },
  });

  if (!res.ok) {
    throw new Error(`Profile request failed: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

async function fetchGraphQL(
  operationId: string,
  operationKey: 'doc_id' | 'query_hash',
  variables: Record<string, unknown>
): Promise<MediaItem[]> {
  const qs = new URLSearchParams({
    [operationKey]: operationId,
    variables: JSON.stringify(variables),
  });

  const url = `${OPERATIONS.MEDIA_BY_SHORTCODE.url}?${qs}`;
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      ...IG_HEADERS,
      Origin: 'https://www.instagram.com',
    },
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return data as unknown as MediaItem[];
}
