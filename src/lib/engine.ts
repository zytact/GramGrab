import { parseInstagramUrl } from "./router";
import { resolveUsernameToId } from "./resolver";
import { fetchMediaByShortcode, fetchReelsMedia } from "./graphql";
import {
  normalizeShortcodeMedia,
  normalizeReelsMedia,
} from "./normalizer";
import type { MediaItem } from "./normalizer";

export interface DownloadTask {
  type: "post" | "reel" | "story" | "highlight";
  shortcode?: string;
  username?: string;
  highlightId?: string;
  carouselIndex?: number;
}

export async function buildDownloadTasks(
  url: string,
  carouselIndex?: number
): Promise<DownloadTask[]> {
  const parsed = parseInstagramUrl(url);
  if (!parsed) return [];

  const tasks: DownloadTask[] = [];

  if (parsed.type === "post" || parsed.type === "reel") {
    tasks.push({
      type: parsed.type,
      shortcode: parsed.shortcode,
      carouselIndex: parsed.carouselIndex,
    });
  } else if (parsed.type === "highlight") {
    tasks.push({
      type: "highlight",
      highlightId: parsed.highlightId,
    });
  } else if (parsed.type === "story") {
    tasks.push({
      type: "story",
      username: parsed.username,
    });
  }

  return tasks;
}

export async function executeDownloadTasks(
  tasks: DownloadTask[]
): Promise<MediaItem[]> {
  const allMedia: MediaItem[] = [];

  for (const task of tasks) {
    if (task.type === "post" || task.type === "reel") {
      const raw = await fetchMediaByShortcode(task.shortcode!);
      const items = normalizeShortcodeMedia(raw);
      allMedia.push(...items);
    } else if (task.type === "story") {
      const userId = await resolveUsernameToId(task.username!);
      if (!userId) throw new Error(`Could not resolve username: ${task.username}`);
      const raw = await fetchReelsMedia({ reel_ids: [userId] });
      const items = normalizeReelsMedia(raw);
      allMedia.push(...items);
    } else if (task.type === "highlight") {
      const raw = await fetchReelsMedia({ highlight_reel_ids: [task.highlightId!] });
      const items = normalizeReelsMedia(raw);
      allMedia.push(...items);
    }
  }

  return allMedia;
}