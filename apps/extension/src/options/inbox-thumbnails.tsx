import { useEffect, useRef, useState } from 'react';
import type { DiscoverySummary, InstagramLogin } from '@gramgrab/protocol';
import { browser } from '../lib/browser.ts';
import { sendMessage } from '../messaging/send.ts';
import { concurrencyLimit, halts, type Preview } from './preview-requests.ts';

const PARALLEL_LOADS = 2;

/** A video's poster, or an image itself. */
function thumbnailOf({ media }: Preview) {
  const first = media?.[0];
  if (!first) return undefined;
  return first.type === 'video' ? first.previewUrl : (first.previewUrl ?? first.url);
}

const sessionKey = (entry: DiscoverySummary) => `inbox-thumbnail:${entry.entryId}`;

/**
 * Loads each inbox entry's thumbnail, a few at a time, and keeps its URL in `storage.session` so
 * the browser session asks Instagram once per entry. Watch state in `storage.local` never holds it.
 */
export function useInboxThumbnails(loginOf: (watchId: string) => InstagramLogin) {
  const login = useRef(loginOf);
  login.current = loginOf;
  const [thumbnails] = useState(() => {
    const cache = new Map<string, Promise<string | undefined>>();
    const limit = concurrencyLimit(PARALLEL_LOADS);
    const halted = new Set<InstagramLogin>();
    const fresh = async (entry: DiscoverySummary) => {
      const owner = login.current(entry.watchId);
      if (halted.has(owner)) return undefined;
      const preview = await sendMessage({
        type: 'WATCH_INBOX_PREVIEW',
        entryId: entry.entryId,
        login: owner,
      });
      if (halts(preview)) halted.add(owner);
      const url = thumbnailOf(preview);
      // An empty string records that the entry has nothing to show, which is as final as a URL.
      if (!preview.failure)
        await browser.sessionStorage.set({ [sessionKey(entry)]: url ?? '' }).catch(() => {});
      return url;
    };
    const stored = async (entry: DiscoverySummary) => {
      const key = sessionKey(entry);
      const value = (
        await browser.sessionStorage.get(key).catch((): Record<string, unknown> => ({}))
      )[key];
      return typeof value === 'string' ? value || undefined : fresh(entry);
    };
    const remember = (entryId: string, load: () => Promise<string | undefined>) => {
      const promise = limit(load).catch(() => undefined);
      cache.set(entryId, promise);
      return promise;
    };
    return {
      load: (entry: DiscoverySummary) =>
        cache.get(entry.entryId) ?? remember(entry.entryId, () => stored(entry)),
      /**
       * Replaces a thumbnail the page could not show: inline data through the worker, or else a
       * fresh preview, since a URL kept from earlier in the session may have expired.
       */
      repair: (entry: DiscoverySummary, url: string) =>
        remember(entry.entryId, async () => {
          const { previewUrl } = await sendMessage({ type: 'GET_PREVIEW_URL', url });
          if (previewUrl) return previewUrl;
          await browser.sessionStorage.remove(sessionKey(entry)).catch(() => {});
          return fresh(entry);
        }),
    };
  });
  return thumbnails;
}

/** A row's recorded thumbnail, loaded once the row scrolls near the viewport. */
export function InboxThumbnail({
  entry,
  thumbnails,
}: {
  entry: DiscoverySummary;
  thumbnails: ReturnType<typeof useInboxThumbnails>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  /** `null` once no thumbnail can be shown. */
  const [src, setSrc] = useState<string | null>();
  /** A kept URL may have expired and its fresh one may still need inline data. */
  const repairs = useRef(0);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([row]) => {
        if (!row?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '200px' }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void thumbnails.load(entry).then(url => {
      if (current) setSrc(url ?? null);
    });
    return () => {
      current = false;
    };
  }, [visible, entry, thumbnails]);
  const shape = entry.mediaType === 'avatar' ? ' opt-thumb-round' : '';
  return (
    <span ref={ref} className={`media-thumb opt-thumb${shape}`}>
      {src && (
        <img
          src={src}
          alt=""
          onError={() => {
            if (repairs.current >= 2 || src.startsWith('data:')) return setSrc(null);
            repairs.current++;
            void thumbnails.repair(entry, src).then(url => setSrc(url ?? null));
          }}
        />
      )}
      {entry.childCount !== undefined && entry.mediaType === 'sidecar' && (
        <span className="opt-thumb-count">{entry.childCount}</span>
      )}
    </span>
  );
}
