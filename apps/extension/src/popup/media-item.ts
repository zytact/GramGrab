export interface MediaItem {
  index: number;
  itemIndex?: number;
  mediaId?: string;
  history?: { downloaded: boolean; count: number; latestDownloadedAt?: number };
  type: string;
  url: string;
  filenameHint: string;
  selected: boolean;
  previewUrl?: string;
  width?: number;
  height?: number;
  creatorUsername?: string;
}

export type FrameRuntime = {
  status: 'idle' | 'loading' | 'ready' | 'failed' | 'exporting';
  durationSeconds?: number;
  dataUrl?: string;
  error?: string;
  warning?: string;
};

/** Preview state of one item: `failed` means the fallback preview request did not yield a URL. */
export type PreviewRuntime = 'idle' | 'loading' | 'failed';

/** Everything transient about one media item, so frame, preview and size cannot drift apart. */
export type ItemRuntime = {
  frame: FrameRuntime;
  preview: PreviewRuntime;
  intrinsic?: { width: number; height: number };
};

export type ItemRuntimes = Record<number, ItemRuntime>;

const IDLE_ITEM_RUNTIME: ItemRuntime = { frame: { status: 'idle' }, preview: 'idle' };

export function itemRuntimeAt(runtimes: ItemRuntimes, index: number): ItemRuntime {
  return runtimes[index] ?? IDLE_ITEM_RUNTIME;
}

/** The single write path for item runtime: one update keeps every facet of an item coherent. */
export function updateItemRuntime(
  runtimes: ItemRuntimes,
  index: number,
  update: (current: ItemRuntime) => ItemRuntime
): ItemRuntimes {
  const current = itemRuntimeAt(runtimes, index);
  const next = update(current);
  return next === current ? runtimes : { ...runtimes, [index]: next };
}

export function withFrame(runtime: ItemRuntime, frame: FrameRuntime): ItemRuntime {
  return { ...runtime, frame };
}
