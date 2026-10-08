import { useEffect, useRef, useState } from 'react';
import { DirectExport, FrameExport, SilentExport, type DiscoverySummary } from '@gramgrab/protocol';
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
import { nextRotation } from '../rotation/contracts.ts';

type InboxItem = MediaItem & { entryId: string; child: number; avatar: boolean };

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
    avatar: entry.mediaType === 'avatar',
  }));
  return { items, notices };
}

export function useInboxMedia(onOwnerRefused: () => void = () => {}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [runtimes, setRuntimes] = useState<ItemRuntimes>({});
  const [frames, setFrames] = useState<Record<number, FrameExportSetting>>({});
  const [silent, setSilent] = useState<ReadonlySet<number>>(new Set());
  const [loading, setLoading] = useState(false);
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
    videos.current = {};
    pendingFrameDefaults.current.clear();
    setLoading(false);
  };
  const clear = () => {
    clearPreview();
    setNotices(new Map());
  };
  const fetch = async (entries: readonly DiscoverySummary[]) => {
    clearPreview();
    const current = generation.current;
    setLoading(true);
    const found: InboxItem[] = [];
    const reasons = new Map<string, readonly string[]>();
    let activeEntry: DiscoverySummary | undefined;
    try {
      for (const entry of entries) {
        activeEntry = entry;
        const response = await sendMessage({ type: 'WATCH_INBOX_PREVIEW', entryId: entry.entryId });
        if (current !== generation.current) return;
        if (refusesOwner(response.failure)) {
          clear();
          onOwnerRefused();
          return;
        }
        const result = previewResult(entry, response, found.length);
        found.push(...result.items);
        reasons.set(entry.entryId, result.notices);
      }
    } catch {
      if (activeEntry)
        reasons.set(activeEntry.entryId, [FAILURE_PRESENTATION.SOURCE_UNEXPECTED_FAILURE.title]);
    } finally {
      if (current === generation.current) {
        setItems(found);
        setNotices(previous => new Map([...previous, ...reasons]));
        setLoading(false);
      }
    }
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
  const selections = items
    .filter(item => item.selected)
    .map(item => ({
      entryId: item.entryId,
      child: item.child,
      settings: {
        mode:
          item.type === 'video' && frames[item.index]?.enabled
            ? FrameExport.make({ timestampSeconds: frames[item.index]!.timestampSeconds })
            : silent.has(item.index)
              ? SilentExport.make({ reencode: 'forbid' })
              : DirectExport.make(),
        ...(item.rotation && !item.avatar ? { rotation: item.rotation } : {}),
      },
    }));
  return {
    items,
    runtimes,
    frames,
    silent,
    loading,
    notices: [...notices.values()].flat(),
    selections,
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
      onRotate: (index: number) =>
        setItems(previous =>
          previous.map(item =>
            item.index === index ? { ...item, rotation: nextRotation(item.rotation) } : item
          )
        ),
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
        canRotate={item => !value.items.find(candidate => candidate.index === item.index)?.avatar}
        disabled={disabled}
        model={{
          mediaItems: value.items,
          itemRuntimes: value.runtimes,
          allSelected: value.items.length > 0 && value.items.every(item => item.selected),
          frameExportSettings: value.frames,
          removeAudioIndexes: value.silent,
          attempt: undefined,
          emptyMessage: value.loading
            ? 'Fetching recorded media…'
            : 'Fetch media to preview it before downloading.',
        }}
        actions={value.actions}
      />
    </div>
  );
}
