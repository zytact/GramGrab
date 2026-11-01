import { useEffect, useRef, useState } from 'react';
import type { DiscoverySummary, FailureCode, InstagramLogin } from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';

const PARALLEL_LOADS = 2;

/** Runs at most `max` tasks at once, starting queued ones in order. */
function concurrencyLimit(max: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  return <T,>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            queue.shift()?.();
          });
      };
      if (running < max) start();
      else queue.push(start);
    });
}

/** Failures after which further thumbnail requests would only add Instagram traffic. */
const HALTING = new Set<FailureCode>(['IG_RATE_LIMITED', 'IG_NOT_AUTHENTICATED']);

/**
 * Loads each inbox entry's thumbnail once per page, a few at a time. Thumbnails live in page
 * memory only, so Watch state never holds a media URL.
 */
export function useInboxThumbnails(loginOf: (watchId: string) => InstagramLogin) {
  const login = useRef(loginOf);
  login.current = loginOf;
  const [thumbnails] = useState(() => {
    const cache = new Map<string, Promise<string | undefined>>();
    const limit = concurrencyLimit(PARALLEL_LOADS);
    const halted = new Set<InstagramLogin>();
    const recorded = async (entry: DiscoverySummary) => {
      const owner = login.current(entry.watchId);
      if (halted.has(owner)) return undefined;
      const { media, failure } = await sendMessage({
        type: 'WATCH_INBOX_PREVIEW',
        entryId: entry.entryId,
        login: owner,
      });
      if (failure?._tag === 'CommandFailure' && HALTING.has(failure.failure.code))
        halted.add(owner);
      const first = media?.[0];
      if (!first) return undefined;
      return first.type === 'video' ? first.previewUrl : (first.previewUrl ?? first.url);
    };
    const remember = (entryId: string, load: () => Promise<string | undefined>) => {
      const promise = limit(load).catch(() => undefined);
      cache.set(entryId, promise);
      return promise;
    };
    return {
      load: (entry: DiscoverySummary) =>
        cache.get(entry.entryId) ?? remember(entry.entryId, () => recorded(entry)),
      /** Refetches a thumbnail the page could not show as inline data through the worker. */
      refetchAsData: (entry: DiscoverySummary, url: string) =>
        remember(entry.entryId, async () => {
          const { previewUrl } = await sendMessage({ type: 'GET_PREVIEW_URL', url });
          return previewUrl;
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
            if (src.startsWith('data:')) setSrc(null);
            else void thumbnails.refetchAsData(entry, src).then(url => setSrc(url ?? null));
          }}
        />
      )}
      {entry.childCount !== undefined && entry.mediaType === 'sidecar' && (
        <span className="opt-thumb-count">{entry.childCount}</span>
      )}
    </span>
  );
}
