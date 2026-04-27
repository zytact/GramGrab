const OPERATIONS = {
  MEDIA_BY_SHORTCODE: {
    doc_id: "8845758582119845",
    url: "https://www.instagram.com/graphql/query/",
  },
  REELS_MEDIA: {
    query_hash: "45246d3fe16ccc6577e0bd297a5db1ab",
    url: "https://www.instagram.com/graphql/query/",
  },
} as const;

const IG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "X-IG-App-ID": "936619743392459",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Mode": "cors",
  "Referer": "https://www.instagram.com/",
} as const;

const USER_PROFILE_URL =
  "https://www.instagram.com/api/v1/users/web_profile_info/";

interface ParsedUrl {
  type: "post" | "reel" | "story" | "highlight";
  shortcode?: string;
  username?: string;
  highlightId?: string;
  carouselIndex?: number;
}

function parseInstagramUrl(url: string): ParsedUrl | null {
  try {
    const u = new URL(url);
    if (u.hostname !== "www.instagram.com" && u.hostname !== "instagram.com")
      return null;
    const path = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    if (path.length === 0) return null;
    const [first, second, third] = path;
    if (first === "p" && second) {
      return {
        type: "post",
        shortcode: second,
        carouselIndex: u.searchParams.has("img_index")
          ? parseInt(u.searchParams.get("img_index")!) - 1
          : undefined,
      };
    }
    // /reel/shortcode or /username/reel/shortcode
    if (first === "reel" && second) {
      return { type: "reel", shortcode: second };
    }
    // /username/reel/shortcode format
    if (first !== "p" && first !== "reel" && first !== "stories" && second === "reel" && third) {
      return { type: "reel", shortcode: third };
    }
    if (first === "stories") {
      if (second === "highlights" && third) {
        return { type: "highlight", highlightId: third };
      }
      if (second) {
        return { type: "story", username: second };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveUsernameToId(username: string): Promise<string | null> {
  const res = await fetch(`${USER_PROFILE_URL}?username=${encodeURIComponent(username)}`, {
    credentials: "include",
    headers: { ...IG_HEADERS, "Origin": "https://www.instagram.com" },
  });
  if (!res.ok) return null;
  const data = await res.json() as {
    data?: { user?: { id?: string | number } };
  };
  const userId = data?.data?.user?.id;
  return userId ? String(userId) : null;
}

async function graphqlFetch(
  operationId: string,
  operationKey: "doc_id" | "query_hash",
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({
    [operationKey]: operationId,
    variables: JSON.stringify(variables),
  });
  const res = await fetch(`${OPERATIONS.MEDIA_BY_SHORTCODE.url}?${qs}`, {
    credentials: "include",
    headers: { ...IG_HEADERS, "Origin": "https://www.instagram.com" },
  });
  if (!res.ok) throw new Error(`GraphQL failed: ${res.status}`);
  return res.json();
}

function pickBestVideoResource(
  resources: { src: string; config_width?: number }[]
): string | null {
  if (!resources || resources.length === 0) return null;
  return [...resources].sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0))[0]
    ?.src ?? null;
}

function extractMediaUrls(
  node: Record<string, unknown>
): { displayUrl?: string; videoUrl?: string; videoResources?: { src: string; config_width?: number }[] } {
  return {
    displayUrl: (node.display_url as string | undefined) ?? (node.uri as string | undefined),
    videoUrl: (node.video_url as string | undefined),
    videoResources: node.video_resources as { src: string; config_width?: number }[] | undefined,
  };
}

function unwrapData(data: unknown): Record<string, unknown> {
  const root = data as Record<string, unknown> | undefined;
  return (root?.data as Record<string, unknown>) ?? root ?? {};
}

function walkObjects(root: unknown): Record<string, unknown>[] {
  const seen = new Set<object>();
  const out: Record<string, unknown>[] = [];
  const stack = [root as unknown];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    const obj = cur as Record<string, unknown>;
    out.push(obj);
    for (const value of Object.values(obj)) stack.push(value);
  }

  return out;
}

function findArrayCandidates(root: unknown): unknown[] {
  const seen = new Set<object>();
  const out: unknown[] = [];
  const stack = [root as unknown];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);

    if (Array.isArray(cur)) {
      out.push(cur);
      for (const item of cur) stack.push(item);
      continue;
    }

    for (const value of Object.values(cur as Record<string, unknown>)) stack.push(value);
  }

  return out;
}

interface MediaItem {
  type: "image" | "video";
  url: string;
  width?: number;
  height?: number;
  takenAt?: number;
  filenameHint: string;
}

function normalizeShortcodeMedia(data: unknown): MediaItem[] {
  const items: MediaItem[] = [];
  const root = unwrapData(data);
  const media =
    (root.xdt_shortcode_media as Record<string, unknown> | undefined) ??
    (root.shortcode_media as Record<string, unknown> | undefined) ??
    (root.media as Record<string, unknown> | undefined);
  const candidate =
    media ??
    walkObjects(root).find((obj) => {
      return (
        typeof obj.shortcode === "string" &&
        (typeof obj.display_url === "string" ||
          typeof obj.display_resources === "object" ||
          obj.edge_sidecar_to_children)
      );
    });
  if (!candidate) return items;

  const typename = candidate.__typename as string | undefined;
  const isSidecar =
    typename === "XDTGraphSidecar" ||
    typename === "GraphSidecar" ||
    typename === "Sidecar";
  const isVideo =
    typename === "XDTGraphVideo" ||
    typename === "GraphVideo" ||
    candidate.is_video === true;
  const isImage =
    typename === "XDTGraphImage" ||
    typename === "GraphImage" ||
    typename === "Image" ||
    !isVideo && !isSidecar;
  const shortcode = candidate.shortcode as string | undefined;
  const takenAt = candidate.taken_at_timestamp as number | undefined;
  const id = candidate.id as string | undefined;

  const push = (url: string, type: "image" | "video", w?: number, h?: number) =>
    items.push({ type, url, width: w, height: h, takenAt, filenameHint: `${shortcode ?? id ?? "media"}_${typename ?? type}` });

  if (isSidecar) {
    const children = candidate.edge_sidecar_to_children as
      | { edges?: { node: Record<string, unknown> }[] }
      | undefined;
    children?.edges?.forEach((edge, i) => {
      const n = edge.node;
      const displayResources = n.display_resources as
        | { src: string; config_width?: number; config_height?: number }[]
        | undefined;
      const displayUrl = n.display_url as string | undefined;
      const isChildVideo = n.is_video === true;
      const dims = n.dimensions as { width?: number; height?: number } | undefined;

      // Prefer highest quality from display_resources
      if (displayResources && displayResources.length > 0) {
        const sorted = [...displayResources].sort(
          (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
        );
        const best = sorted[0]?.src;
        if (best) {
          push(best, isChildVideo ? "video" : "image", sorted[0]?.config_width, sorted[0]?.config_height);
        }
      } else if (displayUrl) {
        push(displayUrl, isChildVideo ? "video" : "image", dims?.width, dims?.height);
      }
    });
  } else if (isVideo) {
    const videoResources = candidate.video_resources as
      | { src: string; config_width?: number; config_height?: number }[]
      | undefined;
    const videoUrl = candidate.video_url as string | undefined;
    const dims = candidate.dimensions as { width?: number; height?: number } | undefined;

    if (videoResources && videoResources.length > 0) {
      const sorted = [...videoResources].sort(
        (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
      );
      const best = sorted[0]?.src;
      if (best) push(best, "video", sorted[0]?.config_width, sorted[0]?.config_height);
    } else if (videoUrl) {
      push(videoUrl, "video", dims?.width, dims?.height);
    }
  } else if (isImage) {
    // For images, prefer display_resources for quality selection
    const displayResources = candidate.display_resources as
      | { src: string; config_width?: number; config_height?: number }[]
      | undefined;
    const displayUrl = candidate.display_url as string | undefined;
    const dims = candidate.dimensions as { width?: number; height?: number } | undefined;

    if (displayResources && displayResources.length > 0) {
      const sorted = [...displayResources].sort(
        (a, b) => (b.config_width ?? 0) - (a.config_width ?? 0)
      );
      const best = sorted[0]?.src;
      if (best) push(best, "image", sorted[0]?.config_width, sorted[0]?.config_height);
    } else if (displayUrl) {
      push(displayUrl, "image", dims?.width, dims?.height);
    }
  }

  return items;
}

function normalizeReelsMedia(data: unknown): MediaItem[] {
  const items: MediaItem[] = [];
  const root = unwrapData(data);
  const reels = (root.reels_media as
    | { id?: string; items?: Record<string, unknown>[] }[]
    | undefined) ??
    (root.reels as
      | { id?: string; items?: Record<string, unknown>[] }[]
      | undefined);
  const candidateReels = reels ?? findArrayCandidates(root).find((arr) => {
    return Array.isArray(arr) && arr.some((item) => {
      const obj = item as Record<string, unknown>;
      return !!obj && typeof obj === "object" && (Array.isArray(obj.items) || typeof obj.display_url === "string" || typeof obj.video_url === "string");
    });
  }) as { id?: string; items?: Record<string, unknown>[] }[] | undefined;
  if (!candidateReels) return items;

  for (const reel of candidateReels) {
    const reelId = reel.id ?? "reel";
    for (const item of reel.items ?? []) {
      const { displayUrl, videoUrl, videoResources } = extractMediaUrls(item);
      const isVid = (item.is_video as boolean | undefined) ?? false;
      const takenAt = item.taken_at_timestamp as number | undefined;
      const itemId = item.id as string | undefined;
      const dims = item.dimensions as { width?: number; height?: number } | undefined;

      const push = (url: string, type: "image" | "video", w?: number, h?: number) =>
        items.push({
          type,
          url,
          width: w,
          height: h,
          takenAt,
          filenameHint: `${reelId}_${itemId ?? "item"}`,
        });

      if (isVid) {
        const best = pickBestVideoResource(videoResources ?? []) ?? videoUrl;
        if (best) push(best, "video", dims?.width, dims?.height);
      } else if (displayUrl) {
        push(displayUrl, "image", dims?.width, dims?.height);
      }
    }
  }

  return items;
}

interface DownloadMsg {
  type: "DOWNLOAD";
  url: string;
  carouselIndex?: number;
}

browser.runtime.onMessage.addListener((msg: DownloadMsg) => {
  if (msg.type !== "DOWNLOAD") return;
  return executeDownload(msg.url, msg.carouselIndex)
    .then((media) => ({ media, error: undefined }))
    .catch((err) => ({ media: undefined, error: String(err) }));
});

interface FetchMediaMsg {
  type: "FETCH_MEDIA";
  url: string;
}

browser.runtime.onMessage.addListener((msg: FetchMediaMsg) => {
  if (msg.type !== "FETCH_MEDIA") return;
  return (async () => {
    const parsed = parseInstagramUrl(msg.url);
    if (!parsed) throw new Error("Unsupported Instagram URL");

    let items: MediaItem[] = [];

    if (parsed.type === "post" || parsed.type === "reel") {
      const raw = await graphqlFetch(
        OPERATIONS.MEDIA_BY_SHORTCODE.doc_id,
        "doc_id",
        { shortcode: parsed.shortcode! }
      );
      items = normalizeShortcodeMedia(raw);
    } else if (parsed.type === "highlight") {
      const raw = await graphqlFetch(
        OPERATIONS.REELS_MEDIA.query_hash,
        "query_hash",
        { highlight_reel_ids: [parsed.highlightId!], reel_ids: [], location_ids: [], precomposed_overlay: false }
      );
      items = normalizeReelsMedia(raw);
    } else if (parsed.type === "story") {
      const userId = await resolveUsernameToId(parsed.username!);
      if (!userId) throw new Error(`Could not resolve username: ${parsed.username}`);
      const raw = await graphqlFetch(
        OPERATIONS.REELS_MEDIA.query_hash,
        "query_hash",
        { reel_ids: [userId], highlight_reel_ids: [], location_ids: [], precomposed_overlay: false }
      );
      items = normalizeReelsMedia(raw);
    }

    const media = items.map((item) => ({
      url: item.url,
      type: item.type,
      filenameHint: item.filenameHint,
    }));

    return { media, error: undefined };
  })().catch((err) => ({ media: undefined, error: String(err) }));
});

interface DownloadMediaMsg {
  type: "DOWNLOAD_MEDIA";
  urls: string[];
  hints: string[];
  types: string[];
}

browser.runtime.onMessage.addListener((msg: DownloadMediaMsg) => {
  if (msg.type !== "DOWNLOAD_MEDIA") return;
  return (async () => {
    const { urls, hints, types } = msg;
    for (let i = 0; i < urls.length; i++) {
      const ext = types[i] === "video" ? "mp4" : "jpg";
      const filename = `${hints[i]}_${i + 1}.${ext}`;
      await browser.downloads.download({ url: urls[i], filename, saveAs: false });
    }
    return { error: undefined };
  })().catch((err) => ({ error: String(err) }));
});

// Temporary debug hook to inspect the raw GraphQL response shape from the popup.
browser.runtime.onMessage.addListener((msg: { type?: string; url?: string }) => {
  if (msg.type !== "DEBUG_SHAPE") return;
  return (async () => {
    const parsed = parseInstagramUrl(msg.url ?? "");
    if (!parsed || (parsed.type !== "post" && parsed.type !== "reel")) {
      return { error: "Use a post or reel URL for debug" };
    }
    const raw = await graphqlFetch(OPERATIONS.MEDIA_BY_SHORTCODE.doc_id, "doc_id", {
      shortcode: parsed.shortcode!,
    });
    return { raw };
  })().catch((err) => ({ error: String(err) }));
});

// Debug JSON download handler (popup can't use browser.downloads)
browser.runtime.onMessage.addListener((msg: { type?: string; json?: unknown }) => {
  if (msg.type !== "DOWNLOAD_DEBUG_JSON") return;
  return (async () => {
    if (!msg.json) {
      return { error: "No debug JSON available" };
    }
    const blob = new Blob([JSON.stringify(msg.json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      await browser.downloads.download({
        url,
        filename: `instasave-debug-${Date.now()}.json`,
        saveAs: true,
      });
      return { error: undefined };
    } catch (err) {
      return { error: String(err) };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  })();
});

async function executeDownload(url: string, carouselIndex?: number): Promise<MediaItem[]> {
  const parsed = parseInstagramUrl(url);
  if (!parsed) throw new Error("Unsupported Instagram URL");

  let items: MediaItem[] = [];

  if (parsed.type === "post" || parsed.type === "reel") {
    const raw = await graphqlFetch(
      OPERATIONS.MEDIA_BY_SHORTCODE.doc_id,
      "doc_id",
      { shortcode: parsed.shortcode! }
    );
    items = normalizeShortcodeMedia(raw);
  } else if (parsed.type === "highlight") {
    const raw = await graphqlFetch(
      OPERATIONS.REELS_MEDIA.query_hash,
      "query_hash",
      { highlight_reel_ids: [parsed.highlightId!], reel_ids: [], location_ids: [], precomposed_overlay: false }
    );
    items = normalizeReelsMedia(raw);
  } else if (parsed.type === "story") {
    const userId = await resolveUsernameToId(parsed.username!);
    if (!userId) throw new Error(`Could not resolve username: ${parsed.username}`);
    const raw = await graphqlFetch(
      OPERATIONS.REELS_MEDIA.query_hash,
      "query_hash",
      { reel_ids: [userId], highlight_reel_ids: [], location_ids: [], precomposed_overlay: false }
    );
    items = normalizeReelsMedia(raw);
  }

  if (carouselIndex !== undefined && items[carouselIndex]) {
    items = [items[carouselIndex]];
  }

  if (items.length === 0) {
    throw new Error("No downloadable media found. Instagram may have changed the response shape or the session is not authorized.");
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const ext = item.type === "video" ? "mp4" : "jpg";
    const filename = `${item.filenameHint}_${i + 1}.${ext}`;
    await browser.downloads.download({ url: item.url, filename, saveAs: false });
  }

  return items;
}
