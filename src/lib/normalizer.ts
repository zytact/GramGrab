export interface MediaItem {
  type: 'image' | 'video';
  url: string;
  width?: number;
  height?: number;
  takenAt?: number;
  filenameHint: string;
}

function unwrapData(data: unknown): Record<string, unknown> {
  const root = data as Record<string, unknown> | undefined;
  return (root?.data as Record<string, unknown>) ?? root ?? {};
}

function pickBestVideo(
  resources: { src: string; config_width?: number; config_height?: number }[]
): string | null {
  if (!resources || resources.length === 0) return null;
  const sorted = [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0));
  return sorted[0]?.src ?? null;
}

function extractUrls(node: Record<string, unknown>): {
  displayUrl?: string;
  videoUrl?: string;
  videoResources?: { src: string; config_width?: number; config_height?: number }[];
} {
  return {
    displayUrl: (node.display_url as string | undefined) ?? (node.uri as string | undefined),
    videoUrl: node.video_url as string | undefined,
    videoResources: node.video_resources as
      | { src: string; config_width?: number; config_height?: number }[]
      | undefined,
  };
}

export function normalizeShortcodeMedia(data: unknown): MediaItem[] {
  const items: MediaItem[] = [];

  const root = unwrapData(data);
  let media = root.xdt_shortcode_media as Record<string, unknown> | undefined;

  if (!media) {
    media = root.shortcode_media as Record<string, unknown> | undefined;
  }
  if (!media) return items;

  const { displayUrl, videoUrl, videoResources } = extractUrls(media);
  const shortcode = media.shortcode as string | undefined;
  const typename = media.__typename as string | undefined;
  const takenAt = media.taken_at_timestamp as number | undefined;
  const id = media.id as string | undefined;
  const dims = media.dimensions as { width?: number; height?: number } | undefined;

  const addItem = (url: string, type: 'image' | 'video', width?: number, height?: number) => {
    items.push({
      type,
      url,
      width,
      height,
      takenAt,
      filenameHint: `${shortcode ?? id ?? 'media'}_${typename ?? type}`,
    });
  };

  if (typename === 'GraphSidecar') {
    const children = media.edge_sidecar_to_children as
      | { edges?: { node: Record<string, unknown> }[] }
      | undefined;
    children?.edges?.forEach((edge, _i) => {
      const n = edge.node;
      const displayResources = n.display_resources as
        | { src: string; config_width?: number; config_height?: number }[]
        | undefined;
      const du = (n.display_url as string | undefined) ?? (n.uri as string | undefined);
      const vu = n.video_url as string | undefined;
      const vr = n.video_resources as
        | { src: string; config_width?: number; config_height?: number }[]
        | undefined;
      const isVid = (n.is_video as boolean | undefined) ?? false;
      const w = n.dimensions as { width?: number; height?: number } | undefined;

      if (isVid) {
        const bestUrl = pickBestVideo(vr ?? []) ?? vu;
        if (bestUrl) addItem(bestUrl, 'video', w?.width, w?.height);
      } else if (displayResources && displayResources.length > 0) {
        const sorted = [...displayResources].sort(
          (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
        );
        const best = sorted[0];
        if (best) addItem(best.src, 'image', best.config_width, best.config_height);
      } else if (du) {
        addItem(du, 'image', w?.width, w?.height);
      }
    });
  } else if (typename === 'GraphVideo') {
    const bestUrl = pickBestVideo(videoResources ?? []) ?? videoUrl;
    if (bestUrl) addItem(bestUrl, 'video', dims?.width, dims?.height);
  } else if (typename === 'GraphImage') {
    if (displayUrl) addItem(displayUrl, 'image', dims?.width, dims?.height);
  }

  return items;
}

export function normalizeReelsMedia(data: unknown): MediaItem[] {
  const items: MediaItem[] = [];

  const root = unwrapData(data);
  let reels = root.reels_media as { id?: string; items?: Record<string, unknown>[] }[] | undefined;

  if (!reels) {
    reels = root.reels as { id?: string; items?: Record<string, unknown>[] }[] | undefined;
  }
  if (!reels) return items;

  for (const reel of reels) {
    const reelId = reel.id ?? 'reel';
    for (const item of reel.items ?? []) {
      const { displayUrl, videoUrl, videoResources } = extractUrls(item);
      const isVid = (item.is_video as boolean | undefined) ?? false;
      const takenAt = item.taken_at_timestamp as number | undefined;
      const itemId = item.id as string | undefined;
      const dims = item.dimensions as { width?: number; height?: number } | undefined;

      const addItem = (url: string, type: 'image' | 'video', width?: number, height?: number) => {
        items.push({
          type,
          url,
          width,
          height,
          takenAt,
          filenameHint: `${reelId}_${itemId ?? 'item'}`,
        });
      };

      if (isVid) {
        const bestUrl = pickBestVideo(videoResources ?? []) ?? videoUrl;
        if (bestUrl) addItem(bestUrl, 'video', dims?.width, dims?.height);
      } else if (displayUrl) {
        addItem(displayUrl, 'image', dims?.width, dims?.height);
      }
    }
  }

  return items;
}

function upgradeProfilePicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const upgradedPath = parsed.pathname.replace(/\/s\d+x\d+\//, '/s1080x1080/');
    parsed.pathname = upgradedPath;
    return parsed.toString();
  } catch {
    return url;
  }
}

export function normalizeProfilePicture(
  data: unknown,
  username: string,
  fallbackUrl?: string
): MediaItem[] {
  const items: MediaItem[] = [];
  const root = unwrapData(data);
  const user =
    (root.user as Record<string, unknown> | undefined) ??
    (root.data as Record<string, unknown> | undefined)?.user;
  const picUrl =
    (user?.profile_pic_url_hd as string | undefined) ??
    (user?.profile_pic_url as string | undefined) ??
    fallbackUrl;
  if (!picUrl) return items;
  const upgradedUrl = upgradeProfilePicUrl(picUrl);
  const dims = user?.profile_pic_dimensions as { width?: number; height?: number } | undefined;

  items.push({
    type: 'image',
    url: upgradedUrl,
    width: dims?.width,
    height: dims?.height,
    filenameHint: `${username}_profile`,
  });

  return items;
}
