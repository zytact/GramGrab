export type ContentType = "post" | "reel" | "story" | "highlight";

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
    if (u.hostname !== "www.instagram.com" && u.hostname !== "instagram.com") {
      return null;
    }

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

    if (first === "reel" && second) {
      return { type: "reel", shortcode: second };
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