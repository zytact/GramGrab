import { useEffect, useRef, useState } from 'react';
import {
  DirectExport,
  FrameExport,
  SilentExport,
  type DiscoverySummary,
  type ExportSettings,
  type InstagramLogin,
} from '@gramgrab/protocol';
import { sendMessage } from '../messaging/send.ts';
import type { MessageResponse } from '../messaging/contracts.ts';
import { FAILURE_PRESENTATION } from '../errors/presentation.ts';
import { MediaListSection } from '../popup/media-list.tsx';
import {
  itemRuntimeAt,
  updateItemRuntime,
  type MediaItem,
  type ItemRuntimes,
} from '../popup/media-item.ts';
import { loadVideoMetadata } from '../popup/video-metadata.ts';
import { useFrameSeekEffect } from '../popup/use-frame-seek.ts';
import { withClampedFrameSecond, type FrameExportSetting } from '../frame-export/timestamp.ts';
import { useMediaEdits } from '../popup/use-media-edits.ts';
import { concurrencyLimit } from './inbox-thumbnails.tsx';

const PARALLEL_PREVIEWS = 3;

type InboxItem = MediaItem & { entryId: string; child: number };

function refusesOwner(failure: MessageResponse<'WATCH_INBOX_PREVIEW'>['failure']) {
  return (
    failure?._tag === 'CommandFailure' &&
    (failure.failure.code === 'IG_NOT_AUTHENTICATED' || failure.failure.code === 'WATCH_NOT_FOUND')
  );
}

function previewResult(
  entry: DiscoverySummary,
  response: MessageResponse<'WATCH_INBOX_PREVIEW'>,
  offset: number
) {
  const failure = response.failure;
  const notices = failure
    ? [
        failure._tag === 'CommandFailure'
          ? FAILURE_PRESENTATION[failure.failure.code].title
          : failure.message,
      ]
    : [];
  notices.push(
    ...(response.unavailable ?? []).map(
      gone => `Item ${gone.child + 1}: ${FAILURE_PRESENTATION[gone.code].title}`
    )
  );
  const items = (response.media ?? []).map((item, index) => ({
    ...item,
    index: offset + index,
    selected: true,
    entryId: entry.entryId,
    child: item.itemIndex,
  }));
  return { items, notices };
}

/** Previews selected inbox entries, each fetched as the login `loginOf` names for its Watch. */
export function useInboxMedia(
  loginOf: (watchId: string) => InstagramLogin,
  onOwnerRefused: () => void = () => {}
) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [runtimes, setRuntimes] = useState<ItemRuntimes>({});
  const [frames, setFrames] = useState<Record<number, FrameExportSetting>>({});
  const [silent, setSilent] = useState<ReadonlySet<number>>(new Set());
  const [cropIndex, setCropIndex] = useState<number>();
  const edits = useMediaEdits(setItems);
  /** Previews loaded so far while a fetch runs. */
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [notices, setNotices] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const generation = useRef(0);
  const videos = useRef<Record<number, HTMLVideoElement | null>>({});
  const pendingFrameDefaults = useRef(new Set<number>());
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  useFrameSeekEffect(frames, runtimes, videos);

  const clearPreview = () => {
    generation.current++;
    setItems([]);
    setRuntimes({});
    setFrames({});
    setSilent(new Set());
    setCropIndex(undefined);
    videos.current = {};
    pendingFrameDefaults.current.clear();
    setProgress(undefined);
  };
  const clear = () => {
    clearPreview();
    setNotices(new Map());
  };
  /** Loads every entry's preview, a few at a time, then shows them in entry order. */
  const fetch = async (entries: readonly DiscoverySummary[]) => {
    clearPreview();
    const current = generation.current;
    setProgress({ done: 0, total: entries.length });
    const limit = concurrencyLimit(PARALLEL_PREVIEWS);
    const responses = await Promise.all(
      entries.map(entry =>
        limit(() =>
          sendMessage({
            type: 'WATCH_INBOX_PREVIEW',
            entryId: entry.entryId,
            login: loginOf(entry.watchId),
          })
        )
          .catch(() => undefined)
          .finally(() => {
            if (current === generation.current)
              setProgress(previous => previous && { ...previous, done: previous.done + 1 });
          })
      )
    );
    if (current !== generation.current) return;
    if (responses.some(response => refusesOwner(response?.failure))) {
      clear();
      onOwnerRefused();
      return;
    }
    const found: InboxItem[] = [];
    const reasons = new Map<string, readonly string[]>();
    entries.forEach((entry, index) => {
      const response = responses[index];
      if (!response) {
        reasons.set(entry.entryId, [FAILURE_PRESENTATION.SOURCE_UNEXPECTED_FAILURE.title]);
        return;
      }
      const result = previewResult(entry, response, found.length);
      found.push(...result.items);
      reasons.set(entry.entryId, result.notices);
    });
    setItems(found);
    setNotices(previous => new Map([...previous, ...reasons]));
    setProgress(undefined);
  };
  const patchRuntime = (index: number, update: Parameters<typeof updateItemRuntime>[2]) =>
    setRuntimes(previous => updateItemRuntime(previous, index, update));
  const duration = (index: number, seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    patchRuntime(index, runtime => ({
      ...runtime,
      frame: { status: 'ready', durationSeconds: seconds },
    }));
    const resetToDefault = pendingFrameDefaults.current.delete(index);
    setFrames(previous => withClampedFrameSecond(previous, index, seconds, resetToDefault));
  };
  const metadata = async (index: number) => {
    const item = items.find(item => item.index === index);
    if (!item) return;
    const current = generation.current;
    const seconds =
      videos.current[index]?.duration ?? itemRuntimeAt(runtimes, index).frame.durationSeconds;
    if (seconds && Number.isFinite(seconds)) {
      duration(index, seconds);
      return;
    }
    patchRuntime(index, runtime => ({ ...runtime, frame: { status: 'loading' } }));
    const result = await loadVideoMetadata(item.url);
    if (current !== generation.current) return;
    if ('error' in result)
      patchRuntime(index, runtime => ({
        ...runtime,
        frame: { status: 'failed', error: result.error },
      }));
    else {
      setItems(previous =>
        previous.map(item => (item.index === index ? { ...item, url: result.dataUrl } : item))
      );
      duration(index, result.durationSeconds);
      patchRuntime(index, runtime => ({ ...runtime, preview: 'idle', previewFailure: undefined }));
    }
  };
  const toggleFrame = (index: number) => {
    const setting = frames[index];
    const enabled = !setting?.enabled;
    setFrames(previous => ({
      ...previous,
      [index]: {
        enabled,
        timestampSeconds: setting?.timestampSeconds ?? 0,
      },
    }));
    if (!setting) pendingFrameDefaults.current.add(index);
    if (enabled) {
      setSilent(previous => new Set([...previous].filter(item => item !== index)));
      void metadata(index);
    }
  };
  const toggleSilent = (index: number) => {
    setSilent(previous => {
      const next = new Set(previous);
      if (!next.delete(index)) next.add(index);
      return next;
    });
    setFrames(previous =>
      previous[index] ? { ...previous, [index]: { ...previous[index], enabled: false } } : previous
    );
  };
  const previewError = async (item: MediaItem) => {
    if (itemRuntimeAt(runtimes, item.index).preview !== 'idle') return;
    const current = generation.current;
    if (item.type === 'video' || item.previewUrl?.startsWith('data:')) {
      patchRuntime(item.index, runtime => ({ ...runtime, preview: 'failed' }));
      return;
    }
    patchRuntime(item.index, runtime => ({ ...runtime, preview: 'loading' }));
    try {
      const response = await sendMessage({ type: 'GET_PREVIEW_URL', url: item.url });
      if (current !== generation.current) return;
      if (response.previewUrl)
        setItems(previous =>
          previous.map(existing =>
            existing.index === item.index
              ? { ...existing, previewUrl: response.previewUrl }
              : existing
          )
        );
      patchRuntime(item.index, runtime => ({
        ...runtime,
        preview: response.previewUrl ? 'idle' : 'failed',
        ...(response.failure ? { previewFailure: response.failure } : {}),
      }));
    } catch {
      if (current === generation.current)
        patchRuntime(item.index, runtime => ({ ...runtime, preview: 'failed' }));
    }
  };
  const settings = (item: InboxItem): ExportSettings => ({
    mode:
      item.type === 'video' && frames[item.index]?.enabled
        ? FrameExport.make({ timestampSeconds: frames[item.index]!.timestampSeconds })
        : silent.has(item.index)
          ? SilentExport.make({ reencode: item.crop ? 'allow' : 'forbid' })
          : DirectExport.make(),
    ...(item.rotation ? { rotation: item.rotation } : {}),
    ...(item.crop ? { crop: item.crop } : {}),
  });
  const chosen = items.filter(item => item.selected);
  const selections = chosen.map(item => ({
    entryId: item.entryId,
    child: item.child,
    settings: settings(item),
  }));
  return {
    items,
    runtimes,
    frames,
    silent,
    loading: progress !== undefined,
    progress,
    notices: [...notices.values()].flat(),
    selections,
    /** A selected video export is cropped, which re-encodes it, so it needs consent first. */
    cropsVideo: chosen.some(
      item => item.type === 'video' && item.crop && !frames[item.index]?.enabled
    ),
    cropIndex,
    canDownload:
      selections.length > 0 &&
      items.every(
        item =>
          !item.selected ||
          !frames[item.index]?.enabled ||
          itemRuntimeAt(runtimes, item.index).frame.status === 'ready'
      ),
    clear,
    clearPreview,
    fetch,
    actions: {
      onToggle: (index: number) =>
        setItems(previous =>
          previous.map(item =>
            item.index === index ? { ...item, selected: !item.selected } : item
          )
        ),
      onToggleAll: () =>
        setItems(previous =>
          previous.map(item => ({ ...item, selected: !previous.every(item => item.selected) }))
        ),
      ...edits,
      onCrop: (index: number) => setCropIndex(current => (current === index ? undefined : index)),
      onToggleExportFrame: toggleFrame,
      onToggleRemoveAudio: toggleSilent,
      onChangeFrameTimestamp: (index: number, timestampSeconds: number) =>
        setFrames(previous => ({ ...previous, [index]: { enabled: true, timestampSeconds } })),
      onRetryFrameMetadata: (index: number) => {
        void metadata(index);
      },
      onRetryFrameExport: (index: number) => {
        void metadata(index);
      },
      onPreviewError: (item: MediaItem) => {
        void previewError(item);
      },
      onVideoRef: (index: number, video: HTMLVideoElement | null) => {
        videos.current[index] = video;
      },
      onVideoMetadata: duration,
      onIntrinsicDimensions: (item: MediaItem, width: number, height: number) =>
        patchRuntime(item.index, runtime => ({ ...runtime, intrinsic: { width, height } })),
    },
  };
}

export function InboxMediaPreview({
  value,
  disabled,
}: {
  value: ReturnType<typeof useInboxMedia>;
  disabled: boolean;
}) {
  return (
    <div className="inbox-media">
      {value.notices.map((notice, index) => (
        <p key={index} className="opt-meta opt-error" role="status">
          {notice}
        </p>
      ))}
      <MediaListSection
        workspaceMode
        disabled={disabled}
        model={{
          mediaItems: value.items,
          itemRuntimes: value.runtimes,
          allSelected: value.items.length > 0 && value.items.every(item => item.selected),
          frameExportSettings: value.frames,
          removeAudioIndexes: value.silent,
          attempt: undefined,
          cropIndex: value.cropIndex,
          emptyMessage: value.progress
            ? `Loading ${value.progress.done} of ${value.progress.total}`
            : 'Nothing to preview.',
        }}
        actions={value.actions}
      />
    </div>
  );
}
